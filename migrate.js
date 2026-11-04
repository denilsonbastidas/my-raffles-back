const mongoose = require("mongoose");
const { Raffle, Ticket } = require("./models");

async function migrateLegacyTickets(raffleId) {
  if (raffleId !== undefined && !mongoose.isValidObjectId(raffleId)) {
    throw new Error("El ID de rifa indicado para migrar no es válido.");
  }
  const legacyFilter = { raffleId: null };
  const count = await Ticket.countDocuments(legacyFilter);
  if (count) {
    const raffles = await Raffle.find().select("_id");
    const target = raffleId
      ? raffles.find((raffle) => String(raffle._id) === String(raffleId))
      : raffles.length === 1
        ? raffles[0]
        : null;
    if (!target) {
      throw new Error(
        "Hay compras sin rifa y no es posible asignarlas con seguridad. Ejecute migrate.js --raffle-id ID después de verificar a qué rifa pertenecen.",
      );
    }
    await Ticket.updateMany(legacyFilter, { $set: { raffleId: target._id } });
    console.log(`Migradas ${count} compras a la rifa ${target._id}`);
  }
  await Raffle.updateMany(
    { status: { $exists: false } },
    { $set: { status: "active", revision: 0 } },
  );
}

if (require.main === module) {
  require("dotenv").config();
  const index = process.argv.indexOf("--raffle-id");
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => {
      if (index >= 0 && !process.argv[index + 1])
        throw new Error("Falta el valor de --raffle-id.");
      return migrateLegacyTickets(
        index >= 0 ? process.argv[index + 1] : undefined,
      );
    })
    .catch((error) => {
      console.error("Migracion abortada:", error);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}

module.exports = { migrateLegacyTickets };
