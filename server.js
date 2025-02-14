require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 5000;

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/ticketsDB";

// 📌 Conectar a MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ Conexión exitosa a MongoDB"))
  .catch((err) => console.error("❌ Error conectando a MongoDB:", err));

// 📌 Definir el modelo Ticket
const TicketSchema = new mongoose.Schema({
  numberTickets: Number,
  fullName: String,
  email: String,
  phone: String,
  reference: String,
  voucher: String,
  createdAt: { type: Date, default: Date.now },
  approved: { type: Boolean, default: false },
  approvalCodes: [String],
});

// 📌 Definir el modelo de la rifa actual
const RaffleSchema = new mongoose.Schema({
  name: String, // Nombre de la rifa
  description: String, // Descripción de la rifa
  ticketPrice: Number, // Precio por boleto
  images: [String],
  createdAt: { type: Date, default: Date.now },
});

const Raffle = mongoose.model("Raffle", RaffleSchema);
const Ticket = mongoose.model("Ticket", TicketSchema);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 📌 Configuración de Multer para subir imágenes
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// 📌 Método para generar códigos únicos de 4 dígitos
const generateApprovalCodes = async (count) => {
  let codes = new Set();

  // Obtener todos los códigos existentes en la base de datos
  const existingCodes = new Set(
    (await Ticket.find({}, { approvalCodes: 1 })).flatMap(
      (ticket) => ticket.approvalCodes
    ) // Convertir en un array plano
  );

  while (codes.size < count) {
    let code = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");

    // Asegurar que no esté en los códigos actuales ni en la base de datos
    if (!codes.has(code) && !existingCodes.has(code)) {
      codes.add(code);
    }
  }

  return Array.from(codes);
};

// 📌 Configuración de Nodemailer
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL,
    pass: process.env.EMAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false, // Agrega esto si sigue fallando
  },
});

// 📌 Endpoint para crear una rifa con imágenes
app.post("/api/raffles", upload.array("images", 5), async (req, res) => {
  try {
    const existingRaffle = await Raffle.findOne();
    if (existingRaffle) {
      return res
        .status(400)
        .json({ error: "Ya existe una rifa activa. No se pueden crear más." });
    }

    const { name, description, ticketPrice } = req.body;
    const images = req.files ? req.files.map((file) => file.filename) : [];

    const newRaffle = new Raffle({
      name,
      description,
      ticketPrice,
      images,
    });

    await newRaffle.save();
    res
      .status(201)
      .json({ message: "Rifa creada exitosamente", raffle: newRaffle });
  } catch (error) {
    console.error("Error al crear la rifa:", error);
    res.status(500).json({ error: "Error al crear la rifa" });
  }
});

// 📌 Endpoint para obtener todas las rifas
app.get("/api/raffles", async (req, res) => {
  try {
    const raffles = await Raffle.find();
    
    // Agrega la URL base a cada imagen
    const updatedRaffles = raffles.map(raffle => ({
      ...raffle._doc,
      images: raffle.images.map(img => `${req.protocol}://${req.get("host")}/uploads/${img}`)
    }));

    res.json(updatedRaffles);
  } catch (error) {
    console.error("Error al obtener rifas:", error);
    res.status(500).json({ error: "Error al obtener rifas" });
  }
});


// 📌 Endpoint para recibir los datos del formulario y guardar en MongoDB
app.post("/api/tickets", upload.single("voucher"), async (req, res) => {
  try {
    const { numberTickets, fullName, email, phone, reference } = req.body;

    const activeRaffle = await Raffle.findOne();
    if (!activeRaffle) {
      return res
        .status(400)
        .json({ error: "No hay una rifa activa en este momento." });
    }

    const newTicket = new Ticket({
      numberTickets,
      fullName,
      email,
      phone,
      reference,
      voucher: req.file ? req.file.filename : null,
    });
    await newTicket.save();

    const mailOptions = {
      from: process.env.EMAIL,
      to: email,
      subject: "Confirmación de compra de ticket para la rifa",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background-color: #f9f9f9;">
          <h2 style="color: #333; text-align: center;">¡Gracias por participar en nuestra rifa "${
            activeRaffle.name
          }"! 🎉</h2>
    
          <p style="font-size: 16px; text-align: center;">Una vez confirmado tu pago, te enviaremos los tickets y/o números de tu compra.</p>
    
          <div style="background: #fff; padding: 15px; border-radius: 8px; box-shadow: 0px 0px 10px rgba(0, 0, 0, 0.1);">
            <h3 style="color: #444;">📌 Detalles de tu compra:</h3>
            <p><strong>👤 Nombre completo:</strong> ${fullName}</p>
            <p><strong>✉️ Email:</strong> ${email}</p>
            <p><strong>📞 Teléfono:</strong> ${phone}</p>
            <p><strong>🎫 Cantidad de boletos comprados:</strong> ${numberTickets}</p>
            <p><strong>🔗 Referencia de pago:</strong> ${reference}</p>
          </div>
    
          ${
            req.file
              ? `
          <div style="margin-top: 20px; text-align: center;">
            <h3 style="color: #444;">🖼️ Imagen del pago:</h3>
            <img src="cid:voucherImage" alt="Comprobante de pago" style="max-width: 100%; border-radius: 8px; border: 1px solid #ddd;">
          </div>`
              : ""
          }
    
          <p style="margin-top: 20px; text-align: center; font-size: 14px; color: #666;">
            ⏳ <strong>Recuerda:</strong> Debes esperar un lapso de <strong>24 a 36 horas</strong> mientras verificamos tu compra.
          </p>
    
          <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

           <p style="font-size: 14px; text-align: center; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>

      <div style="display: flex; justify-content: center; text-align: center;  gap: 15px; ">
        <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
        </a>
        <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
        </a>
        <a href="https://www.facebook.com/denilsonmcgrady" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
        </a>
      </div>
        </div>
      `,
      attachments: req.file
        ? [
            {
              filename: req.file.filename,
              path: req.file.path,
              cid: "voucherImage", // Se usa como referencia en el HTML para mostrar la imagen
            },
          ]
        : [],
    };

    // Enviar el correo
    await transporter.sendMail(mailOptions);
    res
      .status(201)
      .json({ message: "Ticket creado exitosamente", ticket: newTicket });
  } catch (error) {
    console.error("Error al crear el ticket:", error);
    res.status(500).json({ error: "Error al crear el ticket" });
  }
});

// 📌 Endpoint para aprobar el ticket y enviar códigos por correo
app.post("/api/tickets/approve/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    // Obtener todos los códigos ya usados
    const existingCodes = new Set(
      (await Ticket.find({}, { approvalCodes: 1 })).flatMap(
        (t) => t.approvalCodes
      )
    );

    const activeRaffle = await Raffle.findOne();
    if (!activeRaffle) {
      return res
        .status(400)
        .json({ error: "No hay una rifa activa en este momento." });
    }

    // Verificar si aún hay códigos disponibles
    if (existingCodes.size + ticket.numberTickets > process.env.MAX_CODES) {
      return res.status(400).json({ error: "No quedan números disponibles" });
    }

    // Generar códigos y guardar
    const approvalCodes = await generateApprovalCodes(ticket.numberTickets);
    ticket.approved = true;
    ticket.approvalCodes = approvalCodes;
    await ticket.save();

    // Enviar correo
    const mailOptions = {
      from: process.env.EMAIL,
      to: ticket.email,
      subject: "🎟️ ¡Ticket De Rifa Aprobado!",
      html: `
  <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd;">
  <p style="margin-top: 20px;">Holaa, ¡Gracias por tu compra! ${
    activeRaffle.name
  } 🎉</p>
  <h2 style="color: #4CAF50;">✅ ¡Tu ticket ha sido aprobado!</h2>


       <p><strong>📧 Correo asociado:</strong> ${ticket?.email}</p>

    <p>Boleto(s) comprado(s) (${ticket.approvalCodes?.length}):</p>
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 10px; max-width: 100%; margin: 0 auto;">
      ${approvalCodes
        .map(
          (code) => `
          <div style="background: #f4f4f4; margin-bottom: 10px; padding: 12px 16px; border-radius: 8px; font-size: 18px; font-weight: bold; border: 1px solid #ddd; text-align: center;">
           🎟️ ${code}
          </div>
        `
        )
        .join("")}
    </div>
    <strong>Puedes comprar mas y aumentar tus posibilidades de ganar.<br>Estos numeros son elegidos aleatoriamente.</strong>
    <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

      <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>

      <div style=" justify-content: center; gap: 15px; margin: 0px;">
        <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
        </a>
        <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
        </a>
        <a href="https://www.facebook.com/denilsonmcgrady" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
        </a>
      </div>
  </div>
  
  `,
    };
    await transporter.sendMail(mailOptions);
    res
      .status(200)
      .json({ message: "Ticket aprobado y códigos enviados", approvalCodes });
  } catch (error) {
    console.error("Error al aprobar el ticket:", error);
    res.status(500).json({ error: "Error al aprobar el ticket" });
  }
});

// 📌 Endpoint para obtener todos los tickets
app.get("/api/tickets", async (req, res) => {
  try {
    const tickets = await Ticket.find();
    res.json(tickets);
  } catch (error) {
    console.error("Error al obtener tickets:", error);
    res.status(500).json({ error: "Error al obtener los tickets" });
  }
});

// 📌 Endpoint para mostrar cuantos numeros se han vendido (opcional)
app.get("/api/tickets/sold-numbers", async (req, res) => {
  try {
    // Obtener todos los approvalCodes de los tickets aprobados
    const soldNumbers = await Ticket.find(
      { approved: true },
      { approvalCodes: 1 }
    );

    // Extraer los códigos en un solo array
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

// <<<<<<<<< ADMIN authentication >>>>>>>>>>>>>>>> 

// Servir imágenes subidas
app.use("/uploads", express.static("uploads"));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
