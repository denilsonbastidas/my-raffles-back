const mongoose = require("mongoose");

const TicketSchema = new mongoose.Schema(
  {
    raffleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Raffle",
      required: true,
      index: true,
    },
    numberTickets: Number,
    fullName: String,
    email: String,
    phone: String,
    reference: String,
    paymentMethod: String,
    amountPaid: String,
    voucher: String,
    createdAt: { type: Date, default: Date.now },
    approved: { type: Boolean, default: false },
    approvedAt: Date,
    rejected: { type: Boolean, default: false },
    rejectedAt: Date,
    approvalCodes: [String],
  },
  { optimisticConcurrency: true, autoIndex: false },
);

TicketSchema.index(
  { raffleId: 1, approvalCodes: 1 },
  { unique: true, partialFilterExpression: { approved: true } },
);
TicketSchema.index({ raffleId: 1, createdAt: -1 });

const RaffleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: String,
    ticketPrice: { type: Number, required: true, min: 0.01 },
    images: [String],
    visible: { type: Boolean, default: true },
    minValue: {
      type: Number,
      required: true,
      min: 1,
      max: 200,
      validate: Number.isInteger,
    },
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
      index: true,
    },
    closedAt: Date,
    revision: { type: Number, default: 0 },
    prizes: [{ title: String, amount: String }],
    createdAt: { type: Date, default: Date.now },
  },
  { autoIndex: false },
);

module.exports = {
  Raffle: mongoose.model("Raffle", RaffleSchema),
  Ticket: mongoose.model("Ticket", TicketSchema),
  Dollar: mongoose.model("Dollar", new mongoose.Schema({ priceVez: String })),
};
