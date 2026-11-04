const mongoose = require("mongoose");
const { Raffle, Ticket } = require("./models");

const TOTAL_NUMBERS = 10000;
const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

async function withActiveRaffle(raffleId, operation) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      const raffle = await Raffle.findOneAndUpdate(
        { _id: raffleId, status: "active" },
        { $inc: { revision: 1 } },
        { new: true, session },
      );
      if (!raffle) throw httpError(409, "La rifa está cerrada o no existe.");
      return operation(raffle, session);
    });
  } finally {
    await session.endSession();
  }
}

async function reservedCount(raffleId, session, excludeId) {
  const tickets = await Ticket.find({
    raffleId,
    rejected: { $ne: true },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).session(session);
  return tickets.reduce(
    (sum, ticket) =>
      sum +
      (ticket.approved ? ticket.approvalCodes.length : ticket.numberTickets),
    0,
  );
}

function generateCodes(count, existing) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    existing.size + count > TOTAL_NUMBERS
  ) {
    throw httpError(409, "No quedan números disponibles para esta compra.");
  }
  const available = [];
  for (let number = 0; number < TOTAL_NUMBERS; number++) {
    const code = String(number).padStart(4, "0");
    if (!existing.has(code)) available.push(code);
  }
  for (let i = available.length - 1; i > 0; i--) {
    const j = require("crypto").randomInt(i + 1);
    [available[i], available[j]] = [available[j], available[i]];
  }
  return available.slice(0, count);
}

module.exports = {
  TOTAL_NUMBERS,
  httpError,
  withActiveRaffle,
  reservedCount,
  generateCodes,
};
