const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.ADMIN_SECRET = "local-test-admin";
process.env.BREVO_API_KEY = "local-test-email";
const { app, apiInstance } = require("../server");
const { Raffle, Ticket, Dollar } = require("../models");
const { migrateLegacyTickets } = require("../migrate");
const { generateCodes } = require("../raffle-domain");

let database, server, base;
let emails = [];
apiInstance.sendTransacEmail = async (email) => {
  emails.push(email);
  return {};
};

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Promise.all([Raffle.createIndexes(), Ticket.createIndexes()]);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
});

beforeEach(async () => {
  await Promise.all([
    Ticket.deleteMany({}),
    Raffle.deleteMany({}),
    Dollar.deleteMany({}),
  ]);
  emails = [];
});

async function request(method, route, body, admin = true) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: `Bearer ${process.env.ADMIN_SECRET}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    data: response.headers.get("content-type")?.includes("application/json")
      ? await response.json()
      : await response.text(),
  };
}

const raffleData = (name = "Rifa de prueba") => ({
  name,
  description: "Premios de prueba",
  ticketPrice: 2,
  minValue: 1,
  images: ["data:image/png;base64,dGVzdA=="],
  prizes: [{ title: "Mayor", amount: "$100" }],
});
const purchase = {
  numberTickets: 2,
  fullName: "Participante",
  email: "test@example.com",
  phone: "+581234567890",
  reference: "123",
  paymentMethod: "zelle",
  amountPaid: "4",
  voucher: "data:image/png;base64,dGVzdA==",
};

async function createRaffle(name) {
  const response = await request("POST", "/raffles", raffleData(name));
  assert.equal(response.status, 201);
  return response.data.raffle;
}
async function buy(raffle, overrides = {}) {
  const response = await request(
    "POST",
    "/tickets",
    { ...purchase, raffleId: raffle._id, ...overrides },
    false,
  );
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.ticket;
}
const scoped = (route, raffle) =>
  `${route}${route.includes("?") ? "&" : "?"}raffleId=${raffle._id}`;

test("varias rifas activas conservan imágenes y totales independientes", async () => {
  const first = await createRaffle("Primera");
  const second = await createRaffle("Segunda");
  await buy(first);
  await buy(second, { numberTickets: 3 });
  const { data } = await request("GET", "/raffles");
  assert.equal(data.raffles.length, 2);
  assert.equal(
    data.raffles.find((item) => item._id === first._id).totalSoldWithNoAproved,
    2,
  );
  assert.equal(
    data.raffles.find((item) => item._id === second._id).totalSoldWithNoAproved,
    3,
  );
  assert.equal(data.raffles[0].images[0], raffleData().images[0]);
});

test("migración idempotente asigna compras antiguas sin modificar sus datos", async () => {
  const raffle = await createRaffle();
  const result = await Ticket.collection.insertOne({
    ...purchase,
    approved: true,
    approvalCodes: ["0042"],
  });
  await Raffle.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(raffle._id) },
    { $unset: { status: "", revision: "" } },
  );
  await migrateLegacyTickets();
  await migrateLegacyTickets();
  const ticket = await Ticket.findById(result.insertedId);
  assert.equal(String(ticket.raffleId), raffle._id);
  assert.deepEqual([...ticket.approvalCodes], ["0042"]);
  assert.equal(ticket.amountPaid, purchase.amountPaid);
  assert.equal((await Raffle.findById(raffle._id)).status, "active");
});

test("migración ambigua se detiene sin adivinar ni borrar registros", async () => {
  await createRaffle("Uno");
  const second = await createRaffle("Dos");
  await Ticket.collection.insertOne({ ...purchase, approvalCodes: [] });
  await assert.rejects(migrateLegacyTickets(), /sin rifa/);
  assert.equal(await Ticket.countDocuments({ raffleId: null }), 1);
  await migrateLegacyTickets(second._id);
  assert.equal(await Ticket.countDocuments({ raffleId: second._id }), 1);
});

test("consultas, listados, resumen y top aíslan números repetidos entre rifas", async () => {
  const first = await createRaffle("Uno");
  const second = await createRaffle("Dos");
  const firstTicket = await Ticket.create({
    ...purchase,
    raffleId: first._id,
    approved: true,
    approvalCodes: ["0042", "0001"],
  });
  await Ticket.create({
    ...purchase,
    numberTickets: 1,
    amountPaid: "9",
    raffleId: second._id,
    fullName: "Otro",
    approved: true,
    approvalCodes: ["0042"],
  });
  const checked = await request(
    "POST",
    scoped("/tickets/check", first),
    { email: purchase.email },
    false,
  );
  assert.deepEqual(checked.data.data[0].tickets, ["0042", "0001"]);
  const number = await request(
    "GET",
    scoped("/tickets/check?number=42", second),
  );
  assert.equal(number.data.data.fullName, "Otro");
  const list = await request("GET", scoped("/tickets?status=all", first));
  assert.deepEqual(
    list.data.map((item) => item._id),
    [String(firstTicket._id)],
  );
  const sold = await request(
    "GET",
    scoped("/tickets/sold-numbers", first),
    undefined,
    false,
  );
  assert.equal(sold.data.totalSold, 2);
  const top = await request("GET", scoped("/tickets/top-buyers/total", first));
  assert.equal(top.data[0].totalTickets, 2);
  const summary = await request("GET", scoped("/tickets/summary", second));
  assert.equal(summary.data[0].total, 9);
  assert.equal((await request("GET", "/tickets/sold-numbers")).status, 400);
});

test("aprobación simultánea no duplica códigos ni procesa dos veces una compra", async () => {
  const raffle = await createRaffle();
  const first = await buy(raffle);
  const second = await buy(raffle);
  const responses = await Promise.all([
    request("POST", scoped(`/tickets/approve/${first._id}`, raffle), {}),
    request("POST", scoped(`/tickets/approve/${second._id}`, raffle), {}),
    request("POST", scoped(`/tickets/approve/${first._id}`, raffle), {}),
  ]);
  assert.deepEqual(
    responses.map((item) => item.status).sort(),
    [200, 200, 409],
  );
  const tickets = await Ticket.find({ raffleId: raffle._id });
  const codes = tickets.flatMap((item) => item.approvalCodes);
  assert.equal(codes.length, 4);
  assert.equal(new Set(codes).size, 4);
  assert.ok(tickets.every((ticket) => ticket.approvedAt instanceof Date));
  assert.equal(emails.length, 2);
  assert.ok(emails.every((email) => email.htmlContent.includes(raffle.name)));
});

test("mutaciones con un ticket de otra rifa no afectan el original", async () => {
  const first = await createRaffle("Uno");
  const second = await createRaffle("Dos");
  const ticket = await buy(first);
  for (const action of ["approve", "reject", "resend"]) {
    assert.equal(
      (
        await request(
          "POST",
          scoped(`/tickets/${action}/${ticket._id}`, second),
          {},
        )
      ).status,
      404,
    );
  }
  assert.equal(
    (
      await request(
        "PUT",
        scoped(`/tickets/update-contact/${ticket._id}`, second),
        { newEmail: "other@example.com" },
      )
    ).status,
    404,
  );
  assert.equal((await Ticket.findById(ticket._id)).email, purchase.email);
});

test("rechazo conserva registro, libera reserva y permite cerrar sin borrar compras", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  assert.equal(
    (await request("POST", scoped("/raffles/close", raffle), {})).status,
    409,
  );
  assert.equal(
    (await request("POST", scoped(`/tickets/reject/${ticket._id}`, raffle), {}))
      .status,
    200,
  );
  assert.equal((await Ticket.findById(ticket._id)).rejected, true);
  const list = await request("GET", "/raffles");
  assert.equal(list.data.raffles[0].totalSoldWithNoAproved, 0);
  assert.equal(
    (await request("GET", scoped("/tickets", raffle))).data.length,
    0,
  );
  assert.equal(
    (await request("GET", scoped("/tickets?status=all", raffle))).data.length,
    1,
  );
  assert.equal(
    (await request("POST", scoped("/raffles/close", raffle), {})).status,
    200,
  );
  assert.equal(await Ticket.countDocuments({ raffleId: raffle._id }), 1);
  assert.ok((await Raffle.findById(raffle._id)).closedAt);
  await createRaffle("Nueva inmediata");
});

test("rifa cerrada permite consultas y reenvío correcto, pero ninguna modificación", async () => {
  const raffle = await createRaffle("Rifa anterior");
  const ticket = await buy(raffle);
  assert.equal(
    (
      await request(
        "POST",
        scoped(`/tickets/approve/${ticket._id}`, raffle),
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("POST", scoped("/raffles/close", raffle), {})).status,
    200,
  );
  await createRaffle("Nueva");
  assert.equal(
    (
      await request(
        "POST",
        "/tickets",
        { ...purchase, raffleId: raffle._id },
        false,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("PUT", scoped("/raffles", raffle), { name: "Cambio" }))
      .status,
    409,
  );
  assert.equal(
    (await request("POST", scoped("/raffles/toggle-visibility", raffle), {}))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        "POST",
        scoped(`/tickets/approve/${ticket._id}`, raffle),
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("POST", scoped(`/tickets/reject/${ticket._id}`, raffle), {}))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        "PUT",
        scoped(`/tickets/update-contact/${ticket._id}`, raffle),
        { newEmail: "changed@example.com" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "POST",
        scoped("/tickets/check", raffle),
        { email: purchase.email },
        false,
      )
    ).data.data[0].tickets.length,
    2,
  );
  assert.equal(
    (await request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {}))
      .status,
    200,
  );
  assert.ok(emails.at(-1).htmlContent.includes("Rifa anterior"));
  assert.ok(emails.at(-1).htmlContent.includes("Esta rifa está cerrada"));
  assert.ok(!emails.at(-1).htmlContent.includes("Puedes comprar más"));
  assert.equal(
    (await request("DELETE", scoped("/raffles", raffle))).status,
    404,
  );
});

test("validación de cantidades y capacidad por rifa sin bucles al agotarse", async () => {
  const raffle = await createRaffle();
  for (const quantity of [0, -1, 1.5, 201, "2"]) {
    assert.equal(
      (
        await request(
          "POST",
          "/tickets",
          { ...purchase, raffleId: raffle._id, numberTickets: quantity },
          false,
        )
      ).status,
      400,
    );
  }
  await Ticket.create({
    ...purchase,
    raffleId: raffle._id,
    numberTickets: 9999,
  });
  assert.equal(
    (
      await request(
        "POST",
        "/tickets",
        { ...purchase, raffleId: raffle._id },
        false,
      )
    ).status,
    409,
  );
  const other = await createRaffle("Sin reservas");
  await buy(other);
  const used = new Set(
    Array.from({ length: 9999 }, (_, number) =>
      String(number).padStart(4, "0"),
    ),
  );
  assert.deepEqual(generateCodes(1, used), ["9999"]);
  assert.throws(() => generateCodes(2, used), /No quedan/);
});

test("edición usa el precio de la rifa correcta y respeta números ya aprobados", async () => {
  const first = await createRaffle("Uno");
  const second = await createRaffle("Dos");
  await Raffle.updateOne({ _id: second._id }, { $set: { ticketPrice: 7 } });
  await Dollar.create({ priceVez: "40" });
  const ticket = await buy(second);
  const result = await request(
    "PUT",
    scoped(`/tickets/update-contact/${ticket._id}`, second),
    { numberTickets: 3 },
  );
  assert.equal(result.status, 200);
  assert.equal((await Ticket.findById(ticket._id)).amountPaid, "21");
  assert.equal(
    (
      await request(
        "POST",
        scoped(`/tickets/approve/${ticket._id}`, second),
        {},
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "PUT",
        scoped(`/tickets/update-contact/${ticket._id}`, second),
        { numberTickets: 4 },
      )
    ).status,
    409,
  );
  assert.equal(await Ticket.countDocuments({ raffleId: first._id }), 0);
});

test("fallo de correo mantiene aprobación y permite reenviar sin nuevos números", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  const send = apiInstance.sendTransacEmail;
  apiInstance.sendTransacEmail = async () => {
    throw new Error("Fallo SMTP simulado");
  };
  try {
    assert.equal(
      (
        await request(
          "POST",
          scoped(`/tickets/approve/${ticket._id}`, raffle),
          {},
        )
      ).status,
      502,
    );
  } finally {
    apiInstance.sendTransacEmail = send;
  }
  const approved = await Ticket.findById(ticket._id);
  assert.equal(approved.approved, true);
  assert.equal(
    (
      await request(
        "POST",
        scoped(`/tickets/approve/${ticket._id}`, raffle),
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {}))
      .status,
    200,
  );
  assert.deepEqual(
    [...(await Ticket.findById(ticket._id)).approvalCodes],
    [...approved.approvalCodes],
  );
});

test("mutaciones exigen administrador y rifas ocultas no aceptan compras", async () => {
  assert.equal(
    (await request("POST", "/raffles", raffleData(), false)).status,
    403,
  );
  const raffle = await createRaffle();
  assert.equal(
    (await request("POST", scoped("/raffles/close", raffle), {}, false)).status,
    403,
  );
  assert.equal((await request("PUT", "/raffles", {})).status, 400);
  assert.equal(
    (await request("POST", scoped("/raffles/toggle-visibility", raffle), {}))
      .status,
    200,
  );
  assert.equal(
    (await request("GET", "/raffles", undefined, false)).data.raffles.length,
    0,
  );
  assert.equal((await request("GET", "/raffles")).data.raffles.length, 1);
  assert.equal(
    (
      await request(
        "POST",
        "/tickets",
        { ...purchase, raffleId: raffle._id },
        false,
      )
    ).status,
    409,
  );
});

test("compra y cierre simultáneos nunca dejan compras nuevas en una rifa cerrada", async () => {
  const raffle = await createRaffle();
  const [closing, buying] = await Promise.all([
    request("POST", scoped("/raffles/close", raffle), {}),
    request("POST", "/tickets", { ...purchase, raffleId: raffle._id }, false),
  ]);
  const saved = await Raffle.findById(raffle._id);
  if (closing.status === 200) {
    assert.equal(buying.status, 409);
    assert.equal(saved.status, "closed");
    assert.equal(await Ticket.countDocuments({ raffleId: raffle._id }), 0);
  } else {
    assert.equal(closing.status, 409);
    assert.equal(buying.status, 201);
    assert.equal(saved.status, "active");
  }
});

test("reservas simultáneas respetan exactamente el límite de diez mil", async () => {
  const raffle = await createRaffle();
  await Ticket.create({
    ...purchase,
    raffleId: raffle._id,
    numberTickets: 9998,
  });
  const responses = await Promise.all([
    request("POST", "/tickets", { ...purchase, raffleId: raffle._id }, false),
    request("POST", "/tickets", { ...purchase, raffleId: raffle._id }, false),
  ]);
  assert.deepEqual(responses.map((result) => result.status).sort(), [201, 409]);
  const purchases = await Ticket.find({ raffleId: raffle._id });
  assert.equal(
    purchases.reduce((sum, item) => sum + item.numberTickets, 0),
    10000,
  );
});

test("índice único por rifa impide duplicados y migración sin rifa se detiene", async () => {
  await Ticket.collection.insertOne({ ...purchase, approvalCodes: [] });
  await assert.rejects(migrateLegacyTickets(), /sin rifa/);
  await assert.rejects(migrateLegacyTickets("no-es-un-id"), /no es válido/);
  await Ticket.deleteMany({});
  const raffle = await createRaffle();
  await Ticket.create({
    ...purchase,
    raffleId: raffle._id,
    approved: true,
    approvalCodes: ["0042"],
  });
  await assert.rejects(
    Ticket.create({
      ...purchase,
      raffleId: raffle._id,
      approved: true,
      approvalCodes: ["0042"],
    }),
    (error) => error.code === 11000,
  );
  const listing = await request("GET", scoped("/tickets?status=all", raffle));
  assert.equal(listing.data[0].voucher, purchase.voucher);
});

test("editar y ocultar una rifa no modifica las otras", async () => {
  const first = await createRaffle("Primera");
  const second = await createRaffle("Segunda");
  const edited = await request("PUT", scoped("/raffles", second), {
    name: "Segunda editada", ticketPrice: 9, minValue: 3,
    images: ["data:image/png;base64,dGVzdA==", "foto.jpg"],
  });
  assert.equal(edited.status, 200);
  assert.equal((await Raffle.findById(first._id)).ticketPrice, 2);
  assert.equal((await Raffle.findById(second._id)).ticketPrice, 9);
  assert.equal((await request("POST", scoped("/raffles/toggle-visibility", second), {})).status, 200);
  await buy(first);
  assert.equal((await request("POST", "/tickets", { ...purchase, numberTickets: 3, raffleId: second._id }, false)).status, 409);
  const list = await request("GET", "/raffles");
  const secondData = list.data.raffles.find((raffle) => raffle._id === second._id);
  assert.equal(secondData.images.length, 2);
  assert.ok(secondData.images[1].endsWith("/uploads/foto.jpg"));
});
