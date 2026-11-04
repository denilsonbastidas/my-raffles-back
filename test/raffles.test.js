const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.ADMIN_SECRET = "local-test-admin";
process.env.BREVO_API_KEY = "local-test-email";
const { app, apiInstance } = require("../server");
const { Raffle, Ticket, Dollar, DeletedTicket } = require("../models");
const { migrateLegacyTickets } = require("../migrate");
const { generateCodes } = require("../raffle-domain");
const { deliverNextEmail } = require("../ticket-email");
const deliver = () =>
  deliverNextEmail((email) => apiInstance.sendTransacEmail(email));

let database, server, base;
let emails = [];
apiInstance.sendTransacEmail = async (email) => {
  emails.push(email);
  return {};
};

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri(), { monitorCommands: true });
  await Promise.all([
    Raffle.createIndexes(),
    Ticket.createIndexes(),
    DeletedTicket.createIndexes(),
  ]);
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
    DeletedTicket.deleteMany({}),
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
  assert.equal(emails.length, 0);
  await Promise.all([deliver(), deliver()]);
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
    0,
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
  await deliver();
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
      200,
    );
    await deliver();
    assert.equal(
      (await Ticket.findById(ticket._id)).emailDelivery.status,
      "retrying",
    );
  } finally {
    apiInstance.sendTransacEmail = send;
  }
  const approved = await Ticket.findById(ticket._id);
  assert.equal(approved.approved, true);
  await Ticket.updateOne(
    { _id: ticket._id },
    { $set: { "emailDelivery.nextAttemptAt": new Date(0) } },
  );
  await deliver();
  assert.equal(
    (await Ticket.findById(ticket._id)).emailDelivery.status,
    "sent",
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
    (await request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {}))
      .status,
    200,
  );
  await deliver();
  assert.deepEqual(
    [...(await Ticket.findById(ticket._id)).approvalCodes],
    [...approved.approvalCodes],
  );
});

test("aprobar y editar responden sin esperar al proveedor de correo", async () => {
  const raffle = await createRaffle();
  const first = await buy(raffle);
  const second = await buy(raffle);
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let markSending;
  const sending = new Promise((resolve) => {
    markSending = resolve;
  });
  const send = apiInstance.sendTransacEmail;
  apiInstance.sendTransacEmail = () => {
    markSending();
    return blocked;
  };
  let delivery;
  try {
    let deadline;
    const start = performance.now();
    const approval = await Promise.race([
      request("POST", scoped(`/tickets/approve/${first._id}`, raffle), {}),
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("La aprobación espera al correo")),
          1000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(approval.status, 200);
    assert.equal(approval.data.emailDelivery.status, "queued");
    const approvalMs = performance.now() - start;
    delivery = deliver();
    await sending;
    const editStart = performance.now();
    const commands = [];
    const listener = (event) => commands.push(event.command);
    mongoose.connection.getClient().on("commandStarted", listener);
    let edit;
    try {
      edit = await request(
        "PUT",
        scoped(`/tickets/update-contact/${second._id}`, raffle),
        { newEmail: "fast@example.com" },
      );
    } finally {
      mongoose.connection.getClient().off("commandStarted", listener);
    }
    const editMs = performance.now() - editStart;
    assert.equal(edit.status, 200);
    assert.equal(edit.data.ticket.email, "fast@example.com");
    assert.equal(edit.data.ticket.voucher, undefined);
    assert.equal(
      commands.filter((command) => command.findAndModify === "raffles").length,
      1,
    );
    assert.equal(
      commands.filter((command) => command.findAndModify === "tickets").length,
      1,
    );
    assert.equal(
      commands.filter(
        (command) =>
          command.find === "tickets" ||
          command.find === "raffles" ||
          command.aggregate ||
          command.find === "dollars",
      ).length,
      0,
    );
    assert.ok(approvalMs < 1000 && editMs < 1000);
    console.log(
      `Operaciones sin esperar correo: aprobar ${Math.round(approvalMs)} ms, editar ${Math.round(editMs)} ms`,
    );
  } finally {
    release({});
    if (delivery) await delivery;
    apiInstance.sendTransacEmail = send;
  }
});

test("reenvíos simultáneos y workers concurrentes no duplican el mismo correo", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  await request("POST", scoped(`/tickets/approve/${ticket._id}`, raffle), {});
  const responses = await Promise.all([
    request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {}),
    request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {}),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual((await Promise.all([deliver(), deliver()])).sort(), [
    false,
    true,
  ]);
  assert.equal(emails.length, 1);
  const status = (
    await request(
      "GET",
      scoped(`/tickets/email-status?ids=${ticket._id}`, raffle),
    )
  ).data.tickets[0];
  assert.equal(status.emailDelivery.status, "sent");
  assert.ok(status.emailDelivery.sentAt);
});

test("cola persistente recupera leases vencidos y limita reintentos sin perder números", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  await request("POST", scoped(`/tickets/approve/${ticket._id}`, raffle), {});
  const original = await Ticket.findById(ticket._id);
  await Ticket.updateOne(
    { _id: ticket._id },
    {
      $set: {
        "emailDelivery.status": "sending",
        "emailDelivery.leaseUntil": new Date(0),
        "emailDelivery.leaseId": "old-worker",
      },
    },
  );
  assert.equal(await deliver(), true);
  assert.equal(emails.length, 1);
  assert.equal(
    (await Ticket.findById(ticket._id)).emailDelivery.status,
    "sent",
  );
  await request("POST", scoped(`/tickets/resend/${ticket._id}`, raffle), {});
  const fail = async () => {
    throw new Error("Proveedor no disponible");
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await Ticket.updateOne(
      { _id: ticket._id },
      { $set: { "emailDelivery.nextAttemptAt": new Date(0) } },
    );
    await deliverNextEmail(fail);
    const saved = await Ticket.findById(ticket._id);
    assert.equal(saved.emailDelivery.attempts, attempt);
    assert.equal(
      saved.emailDelivery.status,
      attempt === 5 ? "failed" : "retrying",
    );
  }
  assert.equal(await deliverNextEmail(fail), false);
  const saved = await Ticket.findById(ticket._id);
  assert.deepEqual([...saved.approvalCodes], [...original.approvalCodes]);
  assert.equal(saved.approved, true);
  const response = await request(
    "GET",
    scoped(`/tickets/email-status?ids=${ticket._id}`, raffle),
  );
  assert.equal(response.data.tickets[0].emailDelivery.status, "failed");
  assert.equal(response.data.tickets[0].emailDelivery.attempts, undefined);
  assert.equal(
    (
      await request(
        "GET",
        scoped(`/tickets/email-status?ids=${ticket._id}`, raffle),
        undefined,
        false,
      )
    ).status,
    403,
  );
  const other = await createRaffle("Otra rifa");
  assert.deepEqual(
    (
      await request(
        "GET",
        scoped(`/tickets/email-status?ids=${ticket._id}`, other),
      )
    ).data.tickets,
    [],
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
  assert.equal(listing.data[0].voucher, undefined);
  assert.equal(listing.data[0].hasVoucher, true);
  const voucher = await request(
    "GET",
    scoped(`/tickets/${listing.data[0]._id}/voucher`, raffle),
  );
  assert.equal(voucher.data.voucher, purchase.voucher);
});

test("editar y ocultar una rifa no modifica las otras", async () => {
  const first = await createRaffle("Primera");
  const second = await createRaffle("Segunda");
  const edited = await request("PUT", scoped("/raffles", second), {
    name: "Segunda editada",
    ticketPrice: 9,
    minValue: 3,
    images: ["data:image/png;base64,dGVzdA==", "foto.jpg"],
  });
  assert.equal(edited.status, 200);
  assert.equal((await Raffle.findById(first._id)).ticketPrice, 2);
  assert.equal((await Raffle.findById(second._id)).ticketPrice, 9);
  assert.equal(
    (await request("POST", scoped("/raffles/toggle-visibility", second), {}))
      .status,
    200,
  );
  await buy(first);
  assert.equal(
    (
      await request(
        "POST",
        "/tickets",
        { ...purchase, numberTickets: 3, raffleId: second._id },
        false,
      )
    ).status,
    409,
  );
  const list = await request("GET", "/raffles");
  const secondData = list.data.raffles.find(
    (raffle) => raffle._id === second._id,
  );
  assert.equal(secondData.images.length, 2);
  assert.ok(secondData.images[1].endsWith("/uploads/foto.jpg"));
});

test("admin inicial carga solo la rifa actual y el catálogo no contiene imágenes ni estadísticas", async () => {
  const previous = await createRaffle("Histórica pesada");
  await Raffle.updateOne(
    { _id: previous._id },
    {
      status: "closed",
      closedAt: new Date(),
      images: ["data:image/png;base64," + "A".repeat(500000)],
    },
  );
  const current = await createRaffle("Actual");
  await buy(current);
  const response = await request("GET", "/admin/raffles/current");
  assert.equal(response.status, 200);
  assert.equal(response.data.raffle._id, current._id);
  assert.equal(response.data.raffle.pendingCount, 1);
  assert.equal(response.data.raffle.totalSoldWithNoAproved, 2);
  assert.ok(JSON.stringify(response.data).length < 2000);
  const catalog = await request("GET", "/admin/raffles");
  assert.equal(catalog.data.raffles.length, 2);
  assert.ok(
    catalog.data.raffles.every(
      (raffle) => Object.keys(raffle).sort().join(",") === "_id,name,status",
    ),
  );
  assert.ok(JSON.stringify(catalog.data).length < 1000);
  const selected = await request(
    "GET",
    scoped("/admin/raffles/current", previous),
  );
  assert.equal(selected.data.raffle._id, previous._id);
  assert.equal(
    (await request("GET", "/admin/raffles/current", undefined, false)).status,
    403,
  );
  assert.equal(
    (await request("GET", "/admin/raffles", undefined, false)).status,
    403,
  );
  assert.equal(
    (await request("GET", "/admin/raffles/current?raffleId=incorrecto")).status,
    400,
  );
});

test("admin sin rifas y solo con rifas cerradas conserva el comportamiento", async () => {
  assert.equal(
    (await request("GET", "/admin/raffles/current")).data.raffle,
    null,
  );
  const raffle = await createRaffle("Anterior");
  await request("POST", scoped("/raffles/close", raffle), {});
  assert.equal(
    (await request("GET", "/admin/raffles/current")).data.raffle._id,
    raffle._id,
  );
  assert.equal(
    (
      await request(
        "GET",
        "/admin/raffles/current?raffleId=000000000000000000000000",
      )
    ).status,
    404,
  );
});

test("150 vouchers grandes no viajan en la tabla y se descargan solo bajo demanda", async () => {
  const raffle = await createRaffle();
  const voucher = "data:image/png;base64," + "A".repeat(100000);
  await Ticket.insertMany(
    Array.from({ length: 150 }, (_, index) => ({
      ...purchase,
      fullName: `Cliente ${index}`,
      raffleId: raffle._id,
      voucher,
    })),
  );
  const start = performance.now();
  const listing = await request("GET", scoped("/tickets?status=all", raffle));
  const bytes = Buffer.byteLength(JSON.stringify(listing.data));
  assert.equal(listing.data.length, 150);
  assert.ok(
    listing.data.every((ticket) => !("voucher" in ticket) && ticket.hasVoucher),
  );
  assert.ok(bytes < 150000, `Tabla demasiado pesada: ${bytes} bytes`);
  assert.ok(
    bytes < (voucher.length * 150) / 100,
    "Debe reducir más del 99% del peso de los vouchers",
  );
  console.log(
    `Tabla de 150 compras: ${bytes} bytes en ${Math.round(performance.now() - start)} ms; vouchers excluidos: ${voucher.length * 150} bytes`,
  );
  const first = listing.data[0];
  assert.equal(
    (await request("GET", scoped(`/tickets/${first._id}/voucher`, raffle))).data
      .voucher,
    voucher,
  );
  assert.equal(
    (
      await request(
        "GET",
        scoped(`/tickets/${first._id}/voucher`, raffle),
        undefined,
        false,
      )
    ).status,
    403,
  );
  const other = await createRaffle("Otra");
  assert.equal(
    (await request("GET", scoped(`/tickets/${first._id}/voucher`, other)))
      .status,
    404,
  );
  await Ticket.updateOne({ _id: first._id }, { $unset: { voucher: "" } });
  assert.equal(
    (await request("GET", scoped(`/tickets/${first._id}/voucher`, raffle)))
      .status,
    404,
  );
});

test("editar contacto no recorre las reservas ni requiere tasa del dólar y devuelve solo el ticket ligero", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  await Raffle.updateOne(
    { _id: raffle._id },
    { minValue: 5, images: ["data:image/png;base64," + "A".repeat(500000)] },
  );
  await Ticket.updateOne(
    { _id: ticket._id },
    { voucher: "data:image/png;base64," + "A".repeat(500000) },
  );
  const commands = [];
  const listener = (event) => commands.push(event.command);
  const client = mongoose.connection.getClient();
  client.on("commandStarted", listener);
  let response;
  try {
    response = await request(
      "PUT",
      scoped(`/tickets/update-contact/${ticket._id}`, raffle),
      {
        newEmail: "nuevo@example.com",
        newPhone: "+581112223333",
        numberTickets: 2,
        paymentMethod: "zelle",
      },
    );
  } finally {
    client.off("commandStarted", listener);
  }
  assert.equal(response.status, 200);
  assert.equal(response.data.ticket.email, "nuevo@example.com");
  assert.equal(response.data.ticket.amountPaid, purchase.amountPaid);
  assert.equal(response.data.ticket.voucher, undefined);
  assert.ok(
    !commands.some(
      (command) => command.aggregate || command.find === "dollars",
    ),
    "Editar contacto no debe consultar reservas ni tasa",
  );
  assert.ok(
    commands.some(
      (command) =>
        command.find === "tickets" && command.projection?.voucher === 0,
    ),
  );
  assert.ok(JSON.stringify(response.data).length < 2000);
  assert.equal((await Ticket.findById(ticket._id)).voucher.length, 500022);
});

test("editar cantidades y métodos recalcula importes correctamente y exige tasa solo para bolívares", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  const update = (values) =>
    request(
      "PUT",
      scoped(`/tickets/update-contact/${ticket._id}`, raffle),
      values,
    );
  const dollars = await update({ numberTickets: 3, paymentMethod: "binance" });
  assert.equal(dollars.status, 200);
  assert.equal(dollars.data.ticket.amountPaid, "6");
  assert.equal((await update({ paymentMethod: "BDV" })).status, 500);
  assert.equal((await Ticket.findById(ticket._id)).paymentMethod, "binance");
  await Dollar.create({ priceVez: "40" });
  const bs = await update({ paymentMethod: "BDV" });
  assert.equal(bs.status, 200);
  assert.equal(bs.data.ticket.amountPaid, "240");
  assert.equal(
    (await update({ numberTickets: 4 })).data.ticket.amountPaid,
    "320",
  );
  assert.equal(
    (await update({ paymentMethod: "zelle" })).data.ticket.amountPaid,
    "8",
  );
});

test("eliminar compra aprobada archiva datos, libera números y afecta solo a su rifa", async () => {
  const raffle = await createRaffle();
  const other = await createRaffle("Otra");
  const ticket = await buy(raffle);
  await request("POST", scoped(`/tickets/approve/${ticket._id}`, raffle), {});
  const saved = await Ticket.findById(ticket._id).lean();
  assert.equal(
    (
      await request(
        "DELETE",
        scoped(`/tickets/${ticket._id}`, raffle),
        undefined,
        false,
      )
    ).status,
    403,
  );
  assert.equal(
    (await request("DELETE", scoped(`/tickets/${ticket._id}`, other))).status,
    404,
  );
  const deleted = await request(
    "DELETE",
    scoped(`/tickets/${ticket._id}`, raffle),
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.releasedNumbers, 2);
  assert.equal(await Ticket.findById(ticket._id), null);
  const audit = await DeletedTicket.findOne({ originalTicketId: ticket._id });
  assert.equal(String(audit.raffleId), raffle._id);
  assert.deepEqual([...audit.ticket.approvalCodes], saved.approvalCodes);
  assert.equal(audit.ticket.voucher, purchase.voucher);
  assert.equal(audit.ticket.email, purchase.email);
  assert.ok(audit.deletedAt instanceof Date);
  assert.equal(
    (await request("GET", scoped("/admin/raffles/current", raffle))).data.raffle
      .totalSold,
    0,
  );
  assert.equal(
    (
      await request(
        "GET",
        scoped(`/tickets/check?number=${saved.approvalCodes[0]}`, raffle),
      )
    ).data.sold,
    false,
  );
  assert.equal(
    (
      await request(
        "POST",
        scoped("/tickets/check", raffle),
        { email: purchase.email },
        false,
      )
    ).status,
    404,
  );
  await Ticket.create({
    ...purchase,
    raffleId: raffle._id,
    approved: true,
    approvalCodes: saved.approvalCodes,
  });
  assert.equal(
    (await request("DELETE", scoped(`/tickets/${ticket._id}`, raffle))).status,
    404,
  );
});

test("pendientes se rechazan, solo aprobadas se eliminan, y borrado concurrente no duplica auditoría", async () => {
  const raffle = await createRaffle();
  const ticket = await buy(raffle);
  assert.equal(
    (await request("DELETE", scoped(`/tickets/${ticket._id}`, raffle))).status,
    409,
  );
  assert.ok(await Ticket.findById(ticket._id));
  assert.equal(await DeletedTicket.countDocuments(), 0);
  await request("POST", scoped(`/tickets/reject/${ticket._id}`, raffle), {});
  assert.equal(
    (await request("DELETE", scoped(`/tickets/${ticket._id}`, raffle))).status,
    409,
  );
  assert.equal(
    (await request("GET", scoped("/tickets?status=all", raffle))).data.length,
    0,
  );
  const removable = await buy(raffle);
  await request(
    "POST",
    scoped(`/tickets/approve/${removable._id}`, raffle),
    {},
  );
  const responses = await Promise.all([
    request("DELETE", scoped(`/tickets/${removable._id}`, raffle)),
    request("DELETE", scoped(`/tickets/${removable._id}`, raffle)),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 404],
  );
  assert.equal(
    await DeletedTicket.countDocuments({ originalTicketId: removable._id }),
    1,
  );
  assert.equal(
    (await request("GET", scoped("/admin/raffles/current", raffle))).data.raffle
      .pendingCount,
    0,
  );
  const approved = await buy(raffle);
  await request("POST", scoped(`/tickets/approve/${approved._id}`, raffle), {});
  await request("POST", scoped("/raffles/close", raffle), {});
  assert.equal(
    (await request("DELETE", scoped(`/tickets/${approved._id}`, raffle)))
      .status,
    409,
  );
  assert.ok(await Ticket.findById(approved._id));
});
