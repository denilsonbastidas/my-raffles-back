const { randomUUID } = require("crypto");
const { Ticket, Raffle } = require("./models");

const MAX_ATTEMPTS = 5;
const LEASE_MS = 120000;
const queuedEmail = () => ({
  status: "queued",
  attempts: 0,
  nextAttemptAt: new Date(),
});
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function approvalEmail(ticket, raffle) {
  const codes = ticket.approvalCodes
    .map(
      (code) =>
        `<div style="background:#f4f4f4;margin:10px;padding:12px;border-radius:8px;font-size:18px;font-weight:bold">${escapeHtml(code)}</div>`,
    )
    .join("");
  return {
    sender: { name: "Soporte Rifas", email: "rifasdenilsonbastidas@gmail.com" },
    to: [{ email: ticket.email, name: ticket.fullName }],
    subject: "🎟️ Tus boletos aprobados",
    htmlContent: `
      <div style="font-family:Arial,sans-serif;text-align:center;padding:20px">
        <img src="https://my-raffles-back-production.up.railway.app/images/logo-nuevo.png" alt="Logo" width="100" height="100">
        <h2>¡Tus boletos están aprobados!</h2>
        <p>Hola ${escapeHtml(ticket.fullName)}, estos son tus boletos para <strong>${escapeHtml(raffle.name)}</strong>.</p>
        <p>Correo asociado: ${escapeHtml(ticket.email)}</p>
        <p>Fecha de aprobación: ${new Date(ticket.approvedAt || ticket.createdAt).toLocaleDateString("es-ES")}</p>
        <p>Boleto(s) comprado(s): ${ticket.approvalCodes.length}</p>
        ${codes}
        <p>${
          raffle.status === "closed"
            ? "Esta rifa está cerrada. Tus números se conservan para consulta."
            : "Puedes comprar más y aumentar tus posibilidades de ganar. Estos números son elegidos aleatoriamente."
        }</p>
        <p>Equipo de Denilson Bastidas</p>
        <a href="https://www.tiktok.com/@denilsonbastidas_">TikTok</a> ·
        <a href="https://www.instagram.com/denilsonbastidas">Instagram</a> ·
        <a href="https://www.facebook.com/profile.php?id=61573705346985">Facebook</a>
      </div>`,
  };
}

async function deliverNextEmail(send) {
  const now = new Date();
  const leaseId = randomUUID();
  const ticket = await Ticket.findOneAndUpdate(
    {
      approved: true,
      rejected: { $ne: true },
      $or: [
        {
          "emailDelivery.status": { $in: ["queued", "retrying"] },
          "emailDelivery.nextAttemptAt": { $lte: now },
        },
        {
          "emailDelivery.status": "sending",
          "emailDelivery.leaseUntil": { $lte: now },
        },
      ],
    },
    {
      $set: {
        "emailDelivery.status": "sending",
        "emailDelivery.leaseUntil": new Date(now.getTime() + LEASE_MS),
        "emailDelivery.leaseId": leaseId,
      },
      $inc: { "emailDelivery.attempts": 1 },
    },
    { new: true },
  )
    .select("-voucher")
    .lean();
  if (!ticket) return false;
  const claim = { _id: ticket._id, "emailDelivery.leaseId": leaseId };
  try {
    const raffle = await Raffle.findById(ticket.raffleId)
      .select("name status")
      .lean();
    if (!raffle) throw new Error("Rifa del correo no encontrada.");
    await send(approvalEmail(ticket, raffle));
  } catch (error) {
    const attempts = ticket.emailDelivery.attempts;
    console.error(
      `Correo de ticket ${ticket._id}: intento ${attempts} fallido (${error.status || error.code || "proveedor"}).`,
    );
    await Ticket.updateOne(claim, {
      $set: {
        "emailDelivery.status":
          attempts >= MAX_ATTEMPTS ? "failed" : "retrying",
        "emailDelivery.nextAttemptAt": new Date(
          Date.now() + Math.min(600000, 15000 * 2 ** (attempts - 1)),
        ),
      },
      $unset: { "emailDelivery.leaseId": "", "emailDelivery.leaseUntil": "" },
    });
    return true;
  }
  await Ticket.updateOne(claim, {
    $set: {
      "emailDelivery.status": "sent",
      "emailDelivery.sentAt": new Date(),
    },
    $unset: {
      "emailDelivery.leaseId": "",
      "emailDelivery.leaseUntil": "",
      "emailDelivery.nextAttemptAt": "",
    },
  });
  return true;
}

function startEmailWorker(send) {
  let stopped = false;
  let timer;
  let running = Promise.resolve();
  const tick = () => {
    running = Promise.all(
      [0, 1].map(() =>
        deliverNextEmail(send).catch((error) =>
          console.error("Error en cola de correos:", error),
        ),
      ),
    ).finally(() => {
      if (!stopped) {
        timer = setTimeout(tick, 1000);
        timer.unref();
      }
    });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

module.exports = { queuedEmail, deliverNextEmail, startEmailWorker };
