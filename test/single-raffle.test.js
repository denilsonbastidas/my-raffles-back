const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.ADMIN_SECRET = "local-rollback-test";
process.env.BREVO_API_KEY = "local-test";
process.env.MAX_CODES = "10000";
const {
  app,
  Raffle,
  Ticket,
  Dollar,
  apiInstance,
  verifySingleRaffleDatabase,
} = require("../server");
let database, server, base;
const emails = [];
apiInstance.sendTransacEmail = async (email) => {
  emails.push(email);
  return {};
};

before(async () => {
  database = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(database.getUri());
  await Ticket.collection.createIndex(
    { raffleId: 1, approvalCodes: 1 },
    { unique: true, partialFilterExpression: { approved: true } },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
});
beforeEach(async () => {
  await Promise.all([
    Ticket.collection.deleteMany({}),
    Raffle.collection.deleteMany({}),
    Dollar.deleteMany({}),
    mongoose.connection.db.collection("deletedtickets").deleteMany({}),
  ]);
  emails.length = 0;
});

async function request(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const raffleData = {
  name: "Rifa unica",
  description: "Prueba",
  ticketPrice: 2,
  minValue: 1,
  images: ["data:image/png;base64,dGVzdA=="],
  prizes: [],
};
const purchase = {
  fullName: "Prueba",
  email: "local@example.com",
  phone: "+581234567890",
  numberTickets: 2,
  paymentMethod: "zelle",
  amountPaid: "4",
  reference: "ref",
  voucher: "data:image/png;base64,dGVzdA==",
};

test("una sola rifa: crea, consulta, actualiza y bloquea crear otra sin historial", async () => {
  assert.equal((await request("POST", "/raffles", raffleData)).status, 201);
  assert.equal((await request("POST", "/raffles", raffleData)).status, 400);
  assert.equal(
    (await request("PUT", "/raffles", { name: "Actualizada", ticketPrice: 3 }))
      .status,
    200,
  );
  const result = await request("GET", "/raffles");
  assert.equal(result.data[0].name, "Actualizada");
  assert.equal(result.data[0].status, undefined);
  assert.equal(result.data.raffles, undefined);
  assert.equal(result.data.totalSold, 0);
  await verifySingleRaffleDatabase();
});

test("datos migrados conservan compras aprobadas y ocultan rechazados sin modificar la base", async () => {
  const raffle = await Raffle.collection.insertOne({
    ...raffleData,
    status: "active",
    revision: 3,
  });
  const approved = await Ticket.collection.insertOne({
    ...purchase,
    raffleId: raffle.insertedId,
    approved: true,
    rejected: false,
    approvalCodes: ["0042", "7777"],
    emailDelivery: { status: "sent" },
  });
  const rejected = await Ticket.collection.insertOne({
    ...purchase,
    raffleId: raffle.insertedId,
    approved: false,
    rejected: true,
    approvalCodes: [],
  });
  await verifySingleRaffleDatabase();
  const list = await request("GET", "/tickets?status=all");
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0]._id, String(approved.insertedId));
  assert.equal((await request("GET", "/tickets")).data.length, 0);
  const raffleResult = await request("GET", "/raffles");
  assert.equal(raffleResult.data.totalSold, 2);
  assert.equal(raffleResult.data.totalSoldWithNoAproved, 2);
  assert.equal(
    (await request("GET", "/tickets/sold-numbers")).data.totalSold,
    2,
  );
  assert.equal(
    (await request("GET", "/tickets/check?number=0042")).data.sold,
    true,
  );
  assert.deepEqual(
    (await request("POST", "/tickets/check", { email: purchase.email })).data
      .data[0].tickets,
    ["0042", "7777"],
  );
  assert.equal(
    (await request("POST", `/tickets/approve/${rejected.insertedId}`, {}))
      .status,
    404,
  );
  assert.equal(
    (
      await request("PUT", `/tickets/update-contact/${rejected.insertedId}`, {
        newEmail: "other@example.com",
      })
    ).status,
    404,
  );
  assert.equal(await Ticket.collection.countDocuments({}), 2);
  assert.equal(
    (await Ticket.collection.findOne({ _id: approved.insertedId })).voucher,
    purchase.voucher,
  );
});

test("compras nuevas sin raffleId funcionan con indices migrados: editar, aprobar, reenviar y rechazar", async () => {
  const raffle = await Raffle.collection.insertOne({
    ...raffleData,
    status: "active",
  });
  await Ticket.collection.insertOne({
    ...purchase,
    raffleId: raffle.insertedId,
    approved: true,
    approvalCodes: ["0042", "7777"],
  });
  await Dollar.create({ priceVez: "40" });
  const bought = await request("POST", "/tickets", purchase);
  assert.equal(bought.status, 201);
  const id = bought.data.ticket._id;
  assert.equal(bought.data.ticket.raffleId, undefined);
  const edit = await request("PUT", `/tickets/update-contact/${id}`, {
    newEmail: "edited@example.com",
    numberTickets: 3,
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.ticket.amountPaid, "6");
  const approval = await request("POST", `/tickets/approve/${id}`, {});
  assert.equal(approval.status, 200);
  assert.equal(approval.data.approvalCodes.length, 3);
  assert.ok(
    approval.data.approvalCodes.every(
      (code) => !["0042", "7777"].includes(code),
    ),
  );
  assert.equal(emails.length, 1);
  assert.equal(
    (await request("POST", `/tickets/resend/${id}`, {})).status,
    200,
  );
  assert.equal(emails.length, 2);
  assert.equal((await request("GET", "/tickets/summary")).data[0].total, 10);
  assert.deepEqual(
    (await request("POST", "/tickets/check", { email: "edited@example.com" }))
      .data.data[0].tickets,
    approval.data.approvalCodes,
  );
  const pending = await request("POST", "/tickets", {
    ...purchase,
    email: "reject@example.com",
  });
  assert.equal(
    (await request("POST", `/tickets/reject/${pending.data.ticket._id}`, {}))
      .status,
    200,
  );
  assert.equal(
    await Ticket.collection.countDocuments({
      _id: new mongoose.Types.ObjectId(pending.data.ticket._id),
    }),
    0,
  );
  assert.equal(
    await mongoose.connection.db
      .collection("deletedtickets")
      .countDocuments({}),
    0,
  );
});

test("eliminar la rifa vuelve al flujo original y permite crear otra sin conservar historial", async () => {
  await request("POST", "/raffles", raffleData);
  await request("POST", "/tickets", purchase);
  assert.equal((await request("DELETE", "/raffles")).status, 200);
  assert.equal(await Ticket.collection.countDocuments({}), 0);
  assert.equal(await Raffle.collection.countDocuments({}), 0);
  assert.equal(
    (await request("POST", "/raffles", { ...raffleData, name: "Siguiente" }))
      .status,
    201,
  );
  assert.equal(await Raffle.collection.countDocuments({}), 1);
});

test("inicio rechaza varias rifas, cerradas, compras ajenas y correos pendientes sin borrar datos", async () => {
  await verifySingleRaffleDatabase();
  const first = await Raffle.create(raffleData);
  const second = await Raffle.create(raffleData);
  await assert.rejects(verifySingleRaffleDatabase(), /varias rifas/);
  assert.equal(await Raffle.countDocuments(), 2);
  await Raffle.collection.deleteOne({ _id: second._id });
  await Raffle.collection.updateOne(
    { _id: first._id },
    { $set: { status: "closed" } },
  );
  await assert.rejects(verifySingleRaffleDatabase(), /cerrada/);
  await Raffle.collection.updateOne(
    { _id: first._id },
    { $set: { status: "active" } },
  );
  const foreign = await Ticket.collection.insertOne({
    ...purchase,
    raffleId: second._id,
  });
  await assert.rejects(verifySingleRaffleDatabase(), /otra rifa/);
  await Ticket.collection.deleteOne({ _id: foreign.insertedId });
  await Ticket.collection.insertOne({
    ...purchase,
    raffleId: first._id,
    emailDelivery: { status: "queued" },
  });
  await assert.rejects(verifySingleRaffleDatabase(), /correos pendientes/);
  assert.equal(await Ticket.collection.countDocuments({}), 1);
});
