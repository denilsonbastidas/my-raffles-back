require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");
const moment = require("moment-timezone");
const dns = require("dns");

// Node's c-ares resolver sometimes fails SRV lookups locally even when the OS resolver works; force public DNS.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const EXCHANGE_RATE = 13;

const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: "*",
    methods: "GET,POST,PUT,DELETE",
    allowedHeaders: "Content-Type,Authorization",
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/images", express.static("images"));

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://rifasdenilsonbastidas:x6PmHulZV28FjKfz@clusterrifas.oi7nx.mongodb.net/";

const { Raffle, Ticket, Dollar, DeletedTicket } = require("./models");
const { migrateLegacyTickets } = require("./migrate");
const { TOTAL_NUMBERS, httpError, withActiveRaffle, reservedCount, generateCodes } = require("./raffle-domain");

const isAdmin = (req) => Boolean(process.env.ADMIN_SECRET) &&
  req.get("Authorization") === `Bearer ${process.env.ADMIN_SECRET}`;

app.use("/api", (req, res, next) => {
  const raffleMutation = req.path.startsWith("/raffles") && req.method !== "GET";
  const ticketAdministration = req.path.startsWith("/tickets") && (
    req.method === "PUT" || req.method === "DELETE" ||
    (req.method === "POST" && !["/tickets", "/tickets/check"].includes(req.path)) ||
    (req.method === "GET" && (req.path === "/tickets" || req.path === "/tickets/summary" || req.path.endsWith("/voucher") || req.path.startsWith("/tickets/top-buyers/")))
  );
  if ((raffleMutation || ticketAdministration || req.path.startsWith("/admin/raffles")) && !isAdmin(req)) {
    return res.status(403).json({ error: "Se requiere acceso de administrador." });
  }
  const needsRaffleId = raffleMutation && req.method !== "DELETE" &&
    (req.path !== "/raffles" || req.method === "PUT");
  if (needsRaffleId) {
    if (typeof req.query.raffleId !== "string" || !mongoose.isValidObjectId(req.query.raffleId)) {
      return res.status(400).json({ error: "Se requiere un raffleId válido." });
    }
  }
  next();
});

app.use("/api/tickets", async (req, res, next) => {
  try {
    const id = req.query.raffleId || req.body.raffleId;
    if (typeof id !== "string" || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Se requiere un raffleId válido." });
    }
    const raffle = await Raffle.findById(id).select("-images").lean();
    if (!raffle) return res.status(404).json({ error: "Rifa no encontrada." });
    req.raffle = raffle;
    next();
  } catch (error) {
    console.error("Error al seleccionar rifa:", error);
    res.status(500).json({ error: "No se pudo seleccionar la rifa." });
  }
});

const SibApiV3Sdk = require("sib-api-v3-sdk");
let defaultClient = SibApiV3Sdk.ApiClient.instance;
let apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

function imageUrl(req, value) {
  if (!value) return null;
  if (value.includes("/uploads/data:")) return value.split("/uploads/")[1];
  if (/^(data:|https?:\/\/)/.test(value)) return value;
  return `${req.protocol}://${req.get("host")}/uploads/${value.replace(/^\/?uploads\//, "")}`;
}

app.param("id", (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "ID inválido." });
  next();
});

app.put("/api/dollar", async (req, res) => {
  try {
    const { priceVez } = req.body;

    if (!priceVez) {
      return res.status(400).json({ error: "El campo 'priceVez' es obligatorio." });
    }

    let dollar = await Dollar.findOne();

    if (!dollar) {
      dollar = new Dollar({ priceVez });
    } else {
      dollar.priceVez = priceVez;
    }

    await dollar.save();

    res.status(200).json({ message: "Precio del dólar actualizado", dollar });
  } catch (error) {
    console.error("Error al actualizar el precio del dólar:", error);
    res.status(500).json({ error: "Error del servidor al actualizar el precio" });
  }
});

app.get("/api/dollar", async (req, res) => {
  try {
    const dollar = await Dollar.findOne();

    if (!dollar) {
      return res.status(404).json({ error: "No hay precio del dólar registrado." });
    }

    res.status(200).json(dollar);
  } catch (error) {
    console.error("Error al obtener el precio del dólar:", error);
    res.status(500).json({ error: "Error del servidor al obtener el precio" });
  }
});

// 📌 Endpoint para crear una rifa con imágenes
app.post("/api/raffles", async (req, res) => {
  try {
    const { name, description, minValue, images, prizes } = req.body;
    let ticketPrice = parseFloat(req.body.ticketPrice);

    if (
      !Array.isArray(images) ||
      images.some((img) => typeof img !== "string")
    ) {
      return res.status(400).json({
        error:
          "Las imágenes deben enviarse como un array de strings en Base64.",
      });
    }

    const newRaffle = new Raffle({
      name,
      description,
      ticketPrice,
      images,
      visible: true,
      minValue,
      prizes: Array.isArray(prizes) ? prizes : [],
    });

    await newRaffle.save();
    res
      .status(201)
      .json({ message: "Rifa creada exitosamente", raffle: newRaffle });
  } catch (error) {
    console.error("Error al crear la rifa:", error);
    res.status(error.name === "ValidationError" ? 400 : 500).json({ error: error.name === "ValidationError" ? "Revise el nombre, precio y mínimo de boletos de la rifa." : "Error al crear la rifa" });
  }
});

app.put("/api/raffles", async (req, res) => {
  try {
    const { name, description, ticketPrice, images, minValue, visible, prizes } = req.body;

    if (images && (!Array.isArray(images) || images.some((img) => typeof img !== "string"))) {
      return res.status(400).json({
        error: "Las imágenes deben enviarse como un array de strings en Base64.",
      });
    }

    const updated = await withActiveRaffle(req.query.raffleId, async (raffle, session) => {
    if (name !== undefined) raffle.name = name;
    if (description !== undefined) raffle.description = description;
    if (ticketPrice !== undefined) raffle.ticketPrice = parseFloat(ticketPrice);
    if (minValue !== undefined) raffle.minValue = minValue;
    if (visible !== undefined) raffle.visible = visible;
    if (images !== undefined) raffle.images = images;
    if (prizes !== undefined) raffle.prizes = Array.isArray(prizes) ? prizes : [];

    await raffle.save({ session });
    return raffle;
    });

    res.json({ message: "Rifa actualizada exitosamente", raffle: updated });
  } catch (error) {
    console.error("❌ Error al actualizar la rifa:", error);
    res.status(error.status || (error.name === "ValidationError" ? 400 : 500)).json({ error: error.status ? error.message : "Revise los datos de la rifa." });
  }
});


// Cerrar conserva las compras y bloquea nuevas modificaciones.
app.post("/api/raffles/close", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.query.raffleId)) return res.status(400).json({ error: "raffleId inválido." });
    await withActiveRaffle(req.query.raffleId, async (raffle, session) => {
      const pending = await Ticket.exists({ raffleId: raffle._id, approved: false, rejected: { $ne: true } }).session(session);
      if (pending) throw httpError(409, "Resuelva las compras pendientes antes de cerrar la rifa.");
      raffle.status = "closed";
      raffle.closedAt = new Date();
      await raffle.save({ session });
    });
    res.json({ message: "Rifa cerrada. Se conserva todo su historial." });
  } catch (error) {
    console.error("Error al cerrar la rifa:", error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// cambiar el estado actual de la rifa (mostrar/ocultar)
app.post("/api/raffles/toggle-visibility", async (req, res) => {
  try {
    const updated = await withActiveRaffle(req.query.raffleId, async (raffle, session) => {
    raffle.visible = !raffle.visible;
    await raffle.save({ session });
    return raffle;
    });

    res.json({ message: "Estado actualizado", visible: updated.visible });
  } catch (error) {
    console.error("Error al cambiar visibilidad de la rifa:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Error al actualizar la visibilidad" });
  }
});

async function raffleStats(raffleId) {
  const [stats] = await Ticket.aggregate([
    { $match: { raffleId, rejected: { $ne: true } } },
    { $group: {
      _id: null,
      totalSold: { $sum: { $cond: ["$approved", { $size: { $ifNull: ["$approvalCodes", []] } }, 0] } },
      totalSoldWithNoAproved: { $sum: { $cond: ["$approved", { $size: { $ifNull: ["$approvalCodes", []] } }, "$numberTickets"] } },
      pendingCount: { $sum: { $cond: ["$approved", 0, 1] } },
    } },
  ]);
  return {
    totalSold: stats?.totalSold || 0,
    totalSoldWithNoAproved: stats?.totalSoldWithNoAproved || 0,
    pendingCount: stats?.pendingCount || 0,
  };
}

app.get("/api/admin/raffles/current", async (req, res) => {
  try {
    const { raffleId } = req.query;
    if (raffleId !== undefined && (typeof raffleId !== "string" || !mongoose.isValidObjectId(raffleId))) {
      return res.status(400).json({ error: "raffleId inválido." });
    }
    let raffle = raffleId
      ? await Raffle.findById(raffleId).lean()
      : await Raffle.findOne({ status: "active" }).sort({ createdAt: -1, _id: -1 }).lean();
    if (!raffle && !raffleId) raffle = await Raffle.findOne().sort({ closedAt: -1, _id: -1 }).lean();
    if (!raffle) return raffleId
      ? res.status(404).json({ error: "Rifa no encontrada." })
      : res.json({ raffle: null });
    res.json({ raffle: {
      ...raffle,
      images: raffle.images.map((image) => imageUrl(req, image)),
      ticketPrice: String(raffle.ticketPrice),
      ...await raffleStats(raffle._id),
    } });
  } catch (error) {
    console.error("Error al cargar la rifa seleccionada:", error);
    res.status(500).json({ error: "No se pudo cargar la rifa seleccionada." });
  }
});

app.get("/api/admin/raffles", async (req, res) => {
  try {
    const raffles = await Raffle.find().select("_id name status").sort({ createdAt: -1, _id: -1 }).lean();
    res.json({ raffles });
  } catch (error) {
    console.error("Error al cargar catálogo de rifas:", error);
    res.status(500).json({ error: "No se pudo cargar el catálogo de rifas." });
  }
});

// 📌 Endpoint para obtener rifa actual
app.get("/api/raffles", async (req, res) => {
  try {
    const raffles = await Raffle.find(isAdmin(req) ? {} : { $or: [{ visible: true }, { status: "closed" }] }).sort({ closedAt: -1, createdAt: -1, _id: -1 }).lean();
    const totals = await Ticket.aggregate([
      { $match: { rejected: { $ne: true } } },
      { $group: {
        _id: "$raffleId",
        totalSold: { $sum: { $cond: ["$approved", { $size: { $ifNull: ["$approvalCodes", []] } }, 0] } },
        totalSoldWithNoAproved: { $sum: { $cond: ["$approved", { $size: { $ifNull: ["$approvalCodes", []] } }, "$numberTickets"] } },
      } },
    ]);
    res.json({ raffles: raffles.map((raffle) => ({
      ...raffle,
      images: raffle.images.map((image) => imageUrl(req, image)),
      ticketPrice: String(raffle.ticketPrice),
      totalSold: totals.find((item) => String(item._id) === String(raffle._id))?.totalSold || 0,
      totalSoldWithNoAproved: totals.find((item) => String(item._id) === String(raffle._id))?.totalSoldWithNoAproved || 0,
    })) });
  } catch (error) {
    console.error("Error al obtener rifas:", error);
    res.status(500).json({ error: "Error al obtener rifas" });
  }
});

// 📌 Endpoint para recibir los datos del formulario y guardar en MongoDB
app.post("/api/tickets", async (req, res) => {
  try {
    const {
      numberTickets,
      fullName,
      email,
      phone,
      reference,
      paymentMethod,
      amountPaid,
      voucher,
    } = req.body;

    const newTicket = await withActiveRaffle(req.raffle._id, async (activeRaffle, session) => {
      if (!activeRaffle.visible) throw httpError(409, "La rifa no está disponible para compras.");
      if (!Number.isInteger(numberTickets) || numberTickets < activeRaffle.minValue || numberTickets > 200) {
        throw httpError(400, `La cantidad debe ser un entero entre ${activeRaffle.minValue} y 200.`);
      }
      if (await reservedCount(activeRaffle._id, session) + numberTickets > TOTAL_NUMBERS) {
        throw httpError(409, "No quedan suficientes números disponibles.");
      }
      const ticket = new Ticket({
      raffleId: activeRaffle._id,
      numberTickets,
      fullName,
      email,
      phone,
      reference,
      paymentMethod,
      amountPaid,
      voucher,
      });
      await ticket.save({ session });
      return ticket;
    });

    // const mailOptions = {
    //   from: '"Soporte Rifas" <rifas_support@denilsonbastidas.com>',
    //   to: email,
    //   subject: "Confirmación de compra de ticket para la rifa",
    //   html: `
    //     <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background-color: #ffffff; text-align: center;">

    //       <!-- Logo -->
    //       <div style="margin-bottom: 20px;">
    //         <img src="cid:logoImage" alt="Logo" style="width: 100px; height: 100px; border-radius: 50%; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
    //       </div>

    //       <!-- Título -->
    //       <h2 style="color: #333;">¡Gracias por participar en nuestra rifa <br> "<strong>${
    //         activeRaffle.name
    //       }</strong>" 🎉!</h2>

    //       <p style="font-size: 16px; color: #555;">Una vez confirmado tu pago, te enviaremos los tickets y/o números de tu compra.</p>

    //       <!-- Detalles de compra -->
    //       <div style="background: #f8f8f8; padding: 20px; border-radius: 8px; text-align: left;">
    //         <h3 style="color: #444; text-align: center; margin-bottom: 10px;">📌 Detalles de tu compra:</h3>
    //         <p><strong>👤 Nombre:</strong> ${fullName}</p>
    //         <p><strong>✉️ Email:</strong> ${email}</p>
    //         <p><strong>📞 Teléfono:</strong> ${phone}</p>
    //         <p><strong>🎫 Boletos comprados:</strong> ${numberTickets}</p>
    //         <p><strong>💳 Método de pago:</strong> ${paymentMethod}</p>
    //         <p><strong>🔗 Referencia de pago:</strong> ${reference}</p>
    //         <p><strong>💰 Monto Pagado:</strong> ${amountPaid}${
    //     paymentMethod === "BDV" ? "Bs" : "$"
    //   }</p>
    //    <p><strong>📅 Fecha de Compra:</strong> ${new Date()
    //      .toLocaleDateString("es-ES", {
    //        day: "2-digit",
    //        month: "2-digit",
    //        year: "numeric",
    //      })
    //      .replace(/\//g, "-")}</p>
    //       </div>

    //       <p style="margin-top: 20px; font-size: 14px; color: #666;">
    //         ⏳ <strong>Recuerda:</strong> Debes esperar un lapso de <strong>24 a 36 horas</strong> mientras verificamos tu compra.
    //       </p>

    //       <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

    //       <!-- Redes sociales -->
    //       <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>

    //      <div style=" justify-content: center; gap: 15px; margin: 0px;">
    //     <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
    //       <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
    //     </a>
    //     <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
    //       <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
    //     </a>
    //     <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank" style="text-decoration: none;">
    //       <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
    //     </a>
    //   </div>
    //     </div>
    //   `,
    //   attachments: [
    //     {
    //       filename: "logo.webp",
    //       path: "images/logo.webp",
    //       cid: "logoImage",
    //     },
    //     ...(req.file
    //       ? [
    //           {
    //             filename: req.file.filename,
    //             path: req.file.path,
    //             cid: "voucherImage",
    //           },
    //         ]
    //       : []),
    //   ],
    // };

    // await transporter.sendMail(mailOptions);
    res
      .status(201)
      .json({ message: "Ticket creado exitosamente", ticket: newTicket });
  } catch (error) {
    console.error("Error al crear el ticket:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Error al crear el ticket" });
  }
});

// 📌 Endpoint para aprobar el ticket y enviar códigos por correo
app.post("/api/tickets/approve/:id", async (req, res) => {
  try {
    const activeRaffle = req.raffle;
    const ticket = await withActiveRaffle(activeRaffle._id, async (raffle, session) => {
      const purchase = await Ticket.findOne({ _id: req.params.id, raffleId: raffle._id }).select("-voucher").session(session);
      if (!purchase) throw httpError(404, "Ticket no encontrado en esta rifa.");
      if (purchase.approved || purchase.rejected) throw httpError(409, "Esta compra ya fue procesada.");
      const existing = await Ticket.find({ raffleId: raffle._id, approved: true }).select("approvalCodes").lean().session(session);
      purchase.approvalCodes = generateCodes(purchase.numberTickets, new Set(existing.flatMap((item) => item.approvalCodes)));
      purchase.approved = true;
      purchase.approvedAt = new Date();
      await purchase.save({ session });
      return purchase;
    });
    const approvalCodes = ticket.approvalCodes;

    const sendSmtpEmail = {
      sender: { name: "Soporte Rifas", email: "rifasdenilsonbastidas@gmail.com" },
      to: [{ email: ticket.email, name: ticket.fullName }],
      subject: "🎟️ ¡TU COMPRA HA SIDO CONFIRMADA!",
      htmlContent: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd;">
          <div style="margin-bottom: 20px;">
            <img src="https://my-raffles-back-production.up.railway.app/images/logo-nuevo.png" alt="Logo" style="width: 100px; height: 100px; border-radius: 16px; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          </div>

          <p>Holaa ${ticket?.fullName}, ¡Gracias por tu compra! ${activeRaffle.name} 🎉</p>
          <h2 style="color: #4CAF50;">✅ ¡Felicidades tus tickets han sido aprobados!</h2>

          <p><strong>Usuario:</strong> ${ticket?.fullName}</p>
          <p><strong>📧 Correo asociado:</strong> ${ticket?.email}</p>
          <p><strong>📅 Fecha de aprobación:</strong> ${new Date().toLocaleDateString(
        "es-ES",
        { weekday: "long", year: "numeric", month: "long", day: "numeric" }
      )}</p>

          <p>Ticket(s) comprado(s) (${approvalCodes.length}):</p>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 10px; max-width: 100%; margin: 0 auto;">
            ${approvalCodes.map(
        (code) => `
              <div style="background: #f4f4f4; margin-bottom: 10px; padding: 12px 16px; border-radius: 8px; font-size: 18px; font-weight: bold; border: 1px solid #ddd; text-align: center;">
                🎟️ ${code}
              </div>
            `
      ).join("")}
          </div>

          <strong>Puedes comprar más y aumentar tus posibilidades de ganar.<br>Estos números son elegidos aleatoriamente.</strong>
          <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

          <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>
          <div style=" justify-content: center; gap: 15px; margin: 0px;">
            <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" width="32" height="32">
            </a>
            <a href="https://www.instagram.com/denilsonbastidas" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" width="32" height="32">
            </a>
            <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="32" height="32">
            </a>
          </div>
        </div>
      `,
    };

    try {
      await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (error) {
      console.error("Compra aprobada, fallo en el correo:", error);
      return res.status(502).json({ error: "La compra quedó aprobada, pero falló el correo. Use reenviar; no vuelva a aprobar.", approved: true });
    }

    res
      .status(200)
      .json({ message: "Ticket aprobado y códigos enviados", approvalCodes });
  } catch (error) {
    console.error("Error al aprobar el ticket:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Error al aprobar el ticket" });
  }
});

// 📌 Endpoint para rechazar ticket
app.post("/api/tickets/reject/:id", async (req, res) => {
  try {
    await withActiveRaffle(req.raffle._id, async (raffle, session) => {
      const ticket = await Ticket.findOne({ _id: req.params.id, raffleId: raffle._id }).select("-voucher").session(session);
      if (!ticket) throw httpError(404, "Ticket no encontrado en esta rifa.");
      if (ticket.approved || ticket.rejected) throw httpError(409, "Esta compra ya fue procesada.");
      ticket.rejected = true;
      ticket.rejectedAt = new Date();
      await ticket.save({ session });
    });

    // const activeRaffle = await Raffle.findOne();

    // const userEmail = ticket.email;

    // const mailOptions = {
    //   from: '"Soporte Rifas" <rifas_support@denilsonbastidas.com>',
    //   to: userEmail,
    //   subject: "❌ Ticket de Rifa Rechazado",
    //   html: `
    //   <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd;">

    //   <!-- Logo -->
    //       <div style="margin-bottom: 20px;">
    //         <img src="cid:logoImage" alt="Logo" style="width: 100px; height: 100px; border-radius: 50%; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
    //       </div>

    //     <h2 style="color: #FF0000;">❌ Tu ticket ha sido rechazado</h2>
    //     <p>Hola, lamentamos informarte que tu solicitud de ticket para la rifa ${activeRaffle.name} ha sido rechazada.</p>
    //     <p>Si crees que esto es un error, por favor contacta con nuestro equipo de soporte.</p>
    //     <p><strong>📧 Correo de contacto: </strong>rifasdenilsonbastidas@gmail.com</p>
    //     <p><strong>📲 Numero de contacto: </strong>${process.env.PHONE_NUMBER}</p>
    //     <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

    //     <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>
    //     <div style="justify-content: center; gap: 15px; margin: 0px;">
    //       <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
    //         <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
    //       </a>
    //       <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
    //         <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
    //       </a>
    //       <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank" style="text-decoration: none;">
    //         <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
    //       </a>
    //     </div>
    //   </div>
    //   `,
    //   attachments: [
    //     {
    //       filename: "logo.webp",
    //       path: "images/logo.webp", // Ruta donde tienes la imagen del logo en tu servidor
    //       cid: "logoImage", // Se usa como referencia en el HTML
    //     },
    //   ],
    // };

    // await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Ticket rechazado. Registro conservado." });
  } catch (error) {
    console.error("Error al rechazar el ticket:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Error al rechazar el ticket" });
  }
});

app.get("/api/tickets/top-buyers/:mode", async (req, res) => {
  try {
    const { mode } = req.params;
    const { startDate, endDate } = req.query;
    let match = { approved: true, raffleId: req.raffle._id };

    if (mode === "today") {
      const startOfDay = moment.tz("America/Caracas").startOf("day").toDate();
      const endOfDay = moment.tz("America/Caracas").endOf("day").toDate();
      match.createdAt = { $gte: startOfDay, $lte: endOfDay };

    } else if (mode === "yesterday") {
      const startOfYesterday = moment.tz("America/Caracas").subtract(1, "day").startOf("day").toDate();
      const endOfYesterday = moment.tz("America/Caracas").subtract(1, "day").endOf("day").toDate();
      match.createdAt = { $gte: startOfYesterday, $lte: endOfYesterday };

    } else if (mode === "custom" && startDate && endDate) {
      const start = moment.tz(startDate, "America/Caracas").startOf("day").toDate();
      const end = moment.tz(endDate, "America/Caracas").endOf("day").toDate();
      match.createdAt = { $gte: start, $lte: end };
    }

    const topBuyers = await Ticket.aggregate([
      { $match: match },
      { $addFields: { emailLower: { $toLower: "$email" } } },
      {
        $group: {
          _id: "$emailLower",
          fullName: { $first: "$fullName" },
          phone: { $first: "$phone" },
          totalTickets: { $sum: { $size: { $ifNull: ["$approvalCodes", []] } } },
          purchases: { $sum: 1 },
        },
      },
      { $sort: { totalTickets: -1 } },
      { $limit: 10 },
    ]);

    res.json(topBuyers);
  } catch (error) {
    console.error("Error al obtener el top de compradores:", error);
    res.status(500).json({ error: "Error al obtener el top de compradores" });
  }
});


app.get("/api/tickets/summary", async (req, res) => {
  try {
    const summary = await Ticket.aggregate([
      {
        $match: { approved: true, raffleId: req.raffle._id },
      },
      {
        $addFields: {
          amountPaidNumber: { $toDouble: "$amountPaid" },
        },
      },
      {
        $group: {
          _id: "$paymentMethod",
          total: { $sum: "$amountPaidNumber" },
        },
      },
      {
        $project: {
          _id: 0,
          paymentMethod: "$_id",
          total: 1,
        },
      },
    ]);

    res.json(summary);
  } catch (error) {
    console.error("Error al obtener el resumen de pagos:", error);
    res.status(500).json({ error: "Error al obtener el resumen de pagos" });
  }
});

// 📌 Endpoint para reenviar el ticket aprobado por correo
app.post("/api/tickets/resend/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, raffleId: req.raffle._id }).select("-voucher").lean();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    if (!ticket.approved) {
      return res.status(400).json({ error: "El ticket aún no ha sido aprobado." });
    }

    const activeRaffle = req.raffle;
    if (!activeRaffle) {
      return res.status(400).json({ error: "No hay una rifa activa en este momento." });
    }

    const sendSmtpEmail = {
      sender: { name: "Soporte Rifas", email: "rifasdenilsonbastidas@gmail.com" },
      to: [{ email: ticket.email, name: ticket.fullName }],
      subject: "🎟️ Reenvío de Ticket Aprobado",
      htmlContent: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd;">
          <div style="margin-bottom: 20px;">
            <img src="https://my-raffles-back-production.up.railway.app/images/logo-nuevo.png" alt="Logo" 
                 style="width: 100px; height: 100px; border-radius: 16px; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          </div>

          <p>Hola ${ticket?.fullName}, aquí están nuevamente tus boletos aprobados para <strong>${activeRaffle.name}</strong> 🎉</p>
          <h2 style="color: #4CAF50;">${activeRaffle.status === "closed" ? "Boletos aprobados de una rifa cerrada" : "¡Tus boletos están aprobados!"}</h2>

          <p><strong>Usuario:</strong> ${ticket?.fullName}</p>
          <p><strong>📧 Correo asociado:</strong> ${ticket.email}</p>
          <p><strong>📅 Fecha de envío:</strong> ${new Date().toLocaleDateString(
        "es-ES",
        { weekday: "long", year: "numeric", month: "long", day: "numeric" }
      )}</p>

          <p>Boleto(s) comprado(s) (${ticket.approvalCodes.length}):</p>
          <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 10px; max-width: 100%; margin: 0 auto;">
            ${ticket.approvalCodes.map(
        (code) => `
              <div style="background: #f4f4f4; margin-bottom: 10px; padding: 12px 16px; border-radius: 8px; font-size: 18px; font-weight: bold; border: 1px solid #ddd; text-align: center;">
                🎟️ ${code}
              </div>
            `
      ).join("")}
          </div>

          <strong>${activeRaffle.status === "closed" ? "Esta rifa está cerrada. Tus números se conservan para consulta." : "Puedes comprar más y aumentar tus posibilidades de ganar. Estos números son elegidos aleatoriamente."}</strong>
          <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

          <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>
          <div style="justify-content: center; gap: 15px; margin: 0px;">
            <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" width="32" height="32">
            </a>
            <a href="https://www.instagram.com/denilsonbastidas" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" width="32" height="32">
            </a>
            <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank">
              <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" width="32" height="32">
            </a>
          </div>
        </div>
      `,
    };

    await apiInstance.sendTransacEmail(sendSmtpEmail);

    res.status(200).json({ message: "Correo reenviado exitosamente" });
  } catch (error) {
    console.error("Error al reenviar el correo:", error);
    res.status(500).json({ error: "Error al reenviar el correo" });
  }
});

function round(value, decimals = 2) {
  return Number(Math.round(value + "e" + decimals) + "e-" + decimals);
}

app.put("/api/tickets/update-contact/:id", async (req, res) => {
  try {
    const { newEmail, newPhone, numberTickets, paymentMethod } = req.body;

    if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ error: "Email inválido" });
    }

    if (newPhone && !/^[0-9+\-\s]{6,20}$/.test(newPhone)) {
      return res.status(400).json({ error: "Número telefónico inválido" });
    }

    if (numberTickets !== undefined) {
      if (isNaN(numberTickets) || numberTickets <= 0) {
        return res.status(400).json({ error: "numberTickets debe ser mayor que 0" });
      }
    }

    const allowedMethods = ["zelle", "binance", "BDV"];
    if (paymentMethod && !allowedMethods.includes(paymentMethod)) {
      return res
        .status(400)
        .json({ error: "Método de pago inválido. Permitidos: zelle, binance, BDV" });
    }

    const updatedTicket = await withActiveRaffle(req.raffle._id, async (existingRaffle, session) => {
    const ticket = await Ticket.findOne({ _id: req.params.id, raffleId: existingRaffle._id }).select("-voucher").session(session);
    if (!ticket) {
      throw httpError(404, "Ticket no encontrado en esta rifa.");
    }
    if (ticket.rejected) throw httpError(409, "La compra fue rechazada.");
    if (ticket.approved && numberTickets !== undefined && numberTickets !== ticket.numberTickets) {
      throw httpError(409, "No se puede cambiar la cantidad de una compra aprobada.");
    }
    const quantityChanged = numberTickets !== undefined && numberTickets !== ticket.numberTickets;
    if (quantityChanged && (!Number.isInteger(numberTickets) || numberTickets < existingRaffle.minValue || numberTickets > 200)) {
      throw httpError(400, "Cantidad de tickets inválida.");
    }
    if (!ticket.approved && quantityChanged && await reservedCount(existingRaffle._id, session, ticket._id) + numberTickets > TOTAL_NUMBERS) {
      throw httpError(409, "No quedan suficientes números disponibles.");
    }

    const ticketPriceUSD = parseFloat(existingRaffle.ticketPrice);

    const oldPaymentMethod = ticket.paymentMethod;
    const newPaymentMethod = paymentMethod || oldPaymentMethod;
    let dollarPrice;
    if ((quantityChanged || oldPaymentMethod !== newPaymentMethod) &&
        (oldPaymentMethod === "BDV" || newPaymentMethod === "BDV")) {
      const dollar = await Dollar.findOne().select("priceVez").lean().session(session);
      dollarPrice = Number(dollar?.priceVez);
      if (!Number.isFinite(dollarPrice) || dollarPrice <= 0) throw httpError(500, "No se encontró el precio del dólar");
    }

    let recalculatedUSD = null;

    if (numberTickets !== undefined && ticket.numberTickets != numberTickets) {
      recalculatedUSD = ticketPriceUSD * numberTickets;
      ticket.numberTickets = numberTickets;
    }

    if (oldPaymentMethod !== newPaymentMethod) {
      let baseAmountUSD;

      if (recalculatedUSD !== null) {
        baseAmountUSD = recalculatedUSD;
      } else {
        if (oldPaymentMethod === "zelle" || oldPaymentMethod === "binance") {
          baseAmountUSD = parseFloat(ticket.amountPaid);
        } else {
          baseAmountUSD = parseFloat(ticket.amountPaid) / dollarPrice;
        }
      }

      if (newPaymentMethod === "BDV") {
        ticket.amountPaid = round(baseAmountUSD * dollarPrice, 2);
      } else {
        ticket.amountPaid = round(baseAmountUSD, 2);
      }

      ticket.paymentMethod = newPaymentMethod;
    }

    if (recalculatedUSD !== null && oldPaymentMethod === newPaymentMethod) {

      if (newPaymentMethod === "BDV") {
        ticket.amountPaid = round(recalculatedUSD * dollarPrice, 2);
      } else {
        ticket.amountPaid = round(recalculatedUSD, 2);
      }
    }

    if (newEmail) ticket.email = newEmail;
    if (newPhone) ticket.phone = newPhone;

    await ticket.save({ session });
    return ticket.toObject();
    });

    res.status(200).json({
      message: "Datos de contacto actualizados correctamente",
      ticket: updatedTicket,
    });
  } catch (error) {
    console.error("Error al actualizar los datos de contacto:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "Error al actualizar los datos de contacto" });
  }
});

app.get("/api/tickets", async (req, res) => {
  try {
    const { status, paymentMethod, page = 1, numbertoshow = 150, order = "desc" } = req.query;
    const pageNumber = parseInt(page, 10);
    const limit = parseInt(numbertoshow, 10);
    const skip = (pageNumber - 1) * limit;

    let filter = { raffleId: req.raffle._id, rejected: { $ne: true }, ...(status === "all" ? {} : { approved: false }) };
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isInteger(limit) || limit < 1 || limit > 150) {
      return res.status(400).json({ error: "Paginación inválida." });
    }

    if (paymentMethod) {
      filter.paymentMethod = paymentMethod;
    }

    const sortOrder = order === "asc" ? 1 : -1;

    const tickets = await Ticket.aggregate([
      { $match: filter },
      { $sort: { _id: sortOrder } },
      { $skip: skip },
      { $limit: limit },
      { $addFields: { hasVoucher: { $ne: [{ $ifNull: ["$voucher", ""] }, ""] } } },
      { $project: { voucher: 0 } },
    ]);

    res.json(tickets);
  } catch (error) {
    console.error("Error al obtener tickets:", error);
    res.status(500).json({ error: "Error al obtener los tickets" });
  }
});

app.get("/api/tickets/:id/voucher", async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, raffleId: req.raffle._id }).select("voucher").lean();
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado en esta rifa." });
    if (!ticket.voucher) return res.status(404).json({ error: "Esta compra no tiene comprobante." });
    res.json({ voucher: imageUrl(req, ticket.voucher) });
  } catch (error) {
    console.error("Error al cargar comprobante:", error);
    res.status(500).json({ error: "No se pudo cargar el comprobante." });
  }
});

app.delete("/api/tickets/:id", async (req, res) => {
  try {
    const deleted = await withActiveRaffle(req.raffle._id, async (raffle, session) => {
      const ticket = await Ticket.findOne({ _id: req.params.id, raffleId: raffle._id }).session(session);
      if (!ticket) throw httpError(404, "Ticket no encontrado en esta rifa.");
      if (!ticket.approved || ticket.rejected) throw httpError(409, "Solo se pueden eliminar compras aprobadas. Para las pendientes use Rechazar.");
      await DeletedTicket.create([{
        raffleId: raffle._id, originalTicketId: ticket._id, ticket: ticket.toObject(),
      }], { session });
      await Ticket.deleteOne({ _id: ticket._id, raffleId: raffle._id }).session(session);
      return { approved: ticket.approved, rejected: ticket.rejected, releasedNumbers: ticket.approvalCodes.length };
    });
    res.json({ message: "Ticket eliminado. Se conservó una copia de auditoría.", ...deleted });
  } catch (error) {
    console.error("Error al eliminar ticket:", error);
    res.status(error.status || 500).json({ error: error.status ? error.message : "No se pudo eliminar el ticket." });
  }
});

// endpoint para saber si el boleto existe
app.get("/api/tickets/check", async (req, res) => {
  try {
    const { number } = req.query;

    if (typeof number !== "string" || !/^\d{1,4}$/.test(number)) {
      return res.status(400).json({
        error: "Se requiere el número de boleto (`number`).",
      });
    }

    const ticket = await Ticket.findOne(
      { raffleId: req.raffle._id, approved: true, approvalCodes: String(number).padStart(4, "0") },
      isAdmin(req) ? "-voucher" : "fullName approvalCodes"
    );

    if (!ticket) {
      return res.status(200).json({
        sold: false,
        message: "Este boleto aún no ha sido vendido.",
      });
    }

    res.status(200).json({
      sold: true,
      data: ticket,
    });
  } catch (error) {
    console.error("Error al verificar el boleto:", error);
    res.status(500).json({ error: "Error al verificar el boleto." });
  }
});



// 📌 Endpoint para mostrar cuantos numeros se han vendido (opcional)
app.get("/api/tickets/sold-numbers", async (req, res) => {
  try {
    const soldNumbers = await Ticket.find(
      { raffleId: req.raffle._id, approved: true },
      { approvalCodes: 1 }
    );

    const allSoldNumbers = soldNumbers.flatMap(
      (ticket) => ticket.approvalCodes
    );

    res.json({
      allSoldNumbers,
      totalSold: allSoldNumbers.length,
    });
  } catch (error) {
    console.error("Error al obtener los números vendidos:", error);
    res.status(500).json({ error: "Error al obtener los números vendidos" });
  }
});

// endpoint para verificar tickets mediante correo electronico 
app.post("/api/tickets/check", async (req, res) => {
  try {
    let { email } = req.body;

    if (!email || typeof email !== "string") {
      return res
        .status(400)
        .json({ error: "Email no proporcionado o inválido" });
    }

    email = email.toLowerCase();

    const escapedEmail = email.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tickets = await Ticket.find({ raffleId: req.raffle._id, rejected: { $ne: true }, email: { $regex: `^${escapedEmail}$`, $options: "i" } });

    if (tickets.length === 0) {
      return res.status(404).json({
        error: "No se encontraron tickets con este correo, El cliente no existe.",
      });
    }

    const approvedTickets = tickets.filter((ticket) => ticket.approved);

    if (approvedTickets.length === 0) {
      return res.status(400).json({
        error:
          "Su compra fue recibida con éxito, pero aún no ha sido aprobada. Por favor, espere mientras verificamos la compra de sus tickets.",
      });
    }

    const allApprovalCodes = approvedTickets.flatMap(
      (ticket) => ticket.approvalCodes
    );

    const firstTicket = approvedTickets[0];

    const result = {
      id: firstTicket._id,
      nombre: firstTicket.fullName,
      email: firstTicket.email,
      tickets: allApprovalCodes,
    };

    return res.status(200).json({ success: true, data: [result] });
  } catch (error) {
    console.error("Error al verificar tickets:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// <<<<<<<<< ADMIN authentication >>>>>>>>>>>>>>>>
app.post("/api/admin/auth", async (req, res) => {
  const { token } = req.body;
  if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "denied" });
  }

  res.json({ message: "Success", token: process.env.ADMIN_SECRET });
});

// Servir imágenes subidas
app.use("/uploads", express.static("uploads"));

// Iniciar servidor
if (require.main === module) {
  mongoose.connect(MONGO_URI)
    .then(() => migrateLegacyTickets())
    .then(() => Promise.all([Raffle.createIndexes(), Ticket.createIndexes(), DeletedTicket.createIndexes()]))
    .then(() => app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`)))
    .catch(async (error) => {
      console.error("Inicio abortado:", error);
      await mongoose.disconnect();
      process.exitCode = 1;
    });
}

module.exports = { app, apiInstance };
