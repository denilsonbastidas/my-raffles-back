require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: "https://www.denilsonbastidas.com",
    methods: "GET,POST,PUT,DELETE",
    allowedHeaders: "Content-Type,Authorization",
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://www.denilsonbastidas.com");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/images", express.static("images"));

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://rifasdenilsonbastidas:x6PmHulZV28FjKfz@clusterrifas.oi7nx.mongodb.net/";

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
  paymentMethod: String,
  amountPaid: String,
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
  visible: { type: Boolean, default: true }, // Nueva propiedad para mostrar u ocultar la rifa
  minValue: Number, // minimo de compra boletos,
  createdAt: { type: Date, default: Date.now },
});

const Raffle = mongoose.model("Raffle", RaffleSchema);
const Ticket = mongoose.model("Ticket", TicketSchema);

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
app.post("/api/raffles", async (req, res) => {
  try {
    const existingRaffle = await Raffle.findOne();
    if (existingRaffle) {
      return res
        .status(400)
        .json({ error: "Ya existe una rifa activa. No se pueden crear más." });
    }

    const { name, description, ticketPrice, minValue, images } = req.body;

    if (!Array.isArray(images) || images.some(img => typeof img !== "string")) {
      return res.status(400).json({ error: "Las imágenes deben enviarse como un array de strings en Base64." });
    }

    const newRaffle = new Raffle({
      name,
      description,
      ticketPrice,
      images, // Ahora guardamos directamente las imágenes en Base64
      visible: true,
      minValue,
    });

    await newRaffle.save();
    res.status(201).json({ message: "Rifa creada exitosamente", raffle: newRaffle });
  } catch (error) {
    console.error("Error al crear la rifa:", error);
    res.status(500).json({ error: "Error al crear la rifa" });
  }
});

// 📌 Endpoint para eliminar la rifa actual
app.delete("/api/raffles", async (req, res) => {
  try {
    const existingRaffle = await Raffle.findOne();
    if (!existingRaffle) {
      return res.status(404).json({ error: "No hay una rifa activa para eliminar." });
    }

    await Ticket.deleteMany({});
    await Raffle.deleteOne({ _id: existingRaffle._id });

    res.status(200).json({ message: "Rifa eliminada exitosamente" });
  } catch (error) {
    console.error("Error al eliminar la rifa:", error);
    res.status(500).json({ error: "Error al eliminar la rifa" });
  }
});

// cambiar el estado actual de la rifa (mostrar/ocultar)
app.post("/api/raffles/toggle-visibility", async (req, res) => {
  try {
    const raffle = await Raffle.findOne();
    if (!raffle) {
      return res.status(404).json({ error: "No hay rifa activa" });
    }

    raffle.visible = !raffle.visible;
    await raffle.save();

    res.json({ message: "Estado actualizado", visible: raffle.visible });
  } catch (error) {
    console.error("Error al cambiar visibilidad de la rifa:", error);
    res.status(500).json({ error: "Error al actualizar la visibilidad" });
  }
});

// 📌 Endpoint para obtener rifa actual
app.get("/api/raffles", async (req, res) => {
  try {
    const raffles = await Raffle.find();

    // Agrega la URL base a cada imagen
    const updatedRaffles = raffles.map((raffle) => ({
      ...raffle._doc,
      images: raffle.images.map(
        (img) => `${req.protocol}://${req.get("host")}/uploads/${img}`
      ),
    }));

    res.json(updatedRaffles);
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
      voucher
    } = req.body;

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
      paymentMethod,
      amountPaid,
      voucher,
    });
    await newTicket.save();

    const mailOptions = {
      from: process.env.EMAIL,
      to: email,
      subject: "Confirmación de compra de ticket para la rifa",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #ddd; padding: 20px; border-radius: 10px; background-color: #ffffff; text-align: center;">
          
          <!-- Logo -->
          <div style="margin-bottom: 20px;">
            <img src="cid:logoImage" alt="Logo" style="width: 100px; height: 100px; border-radius: 50%; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          </div>
    
          <!-- Título -->
          <h2 style="color: #333;">¡Gracias por participar en nuestra rifa <br> "<strong>${
            activeRaffle.name
          }</strong>" 🎉!</h2>
          
          <p style="font-size: 16px; color: #555;">Una vez confirmado tu pago, te enviaremos los tickets y/o números de tu compra.</p>
    
          <!-- Detalles de compra -->
          <div style="background: #f8f8f8; padding: 20px; border-radius: 8px; text-align: left;">
            <h3 style="color: #444; text-align: center; margin-bottom: 10px;">📌 Detalles de tu compra:</h3>
            <p><strong>👤 Nombre:</strong> ${fullName}</p>
            <p><strong>✉️ Email:</strong> ${email}</p>
            <p><strong>📞 Teléfono:</strong> ${phone}</p>
            <p><strong>🎫 Boletos comprados:</strong> ${numberTickets}</p>
            <p><strong>💳 Método de pago:</strong> ${paymentMethod}</p>
            <p><strong>🔗 Referencia de pago:</strong> ${reference}</p>
            <p><strong>💰 Monto Pagado:</strong> ${amountPaid}${
        paymentMethod === "BDV" ? "Bs" : "$"
      }</p>
       <p><strong>📅 Fecha de Compra:</strong> ${new Date()
         .toLocaleDateString("es-ES", {
           day: "2-digit",
           month: "2-digit",
           year: "numeric",
         })
         .replace(/\//g, "-")}</p>
          </div>
    
          <div style={{ marginTop: "20px" }}>
              <h3 style={{ color: "#444" }}>🖼️ Comprobante de pago:</h3>
              ${Array.isArray(voucher) && voucher.length > 0 ? (
                  voucher.map((img, index) => (
                      <img
                          key={index}
                          src={img.split("uploads/")[1]}
                          style={{
                              maxWidth: "100%",
                              borderRadius: "8px",
                              border: "1px solid #ddd",
                              marginTop: "10px",
                          }}
                      />
                  ))
              ) : (
                  <p style={{ color: "#888" }}>No hay comprobantes de pago adjuntos.</p>
              )}
          </div>
    
          <p style="margin-top: 20px; font-size: 14px; color: #666;">
            ⏳ <strong>Recuerda:</strong> Debes esperar un lapso de <strong>24 a 36 horas</strong> mientras verificamos tu compra.
          </p>
    
          <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>
    
          <!-- Redes sociales -->
          <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>
    
         <div style=" justify-content: center; gap: 15px; margin: 0px;">
        <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
        </a>
        <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
        </a>
        <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
        </a>
      </div>
        </div>
      `,
      attachments: [
        {
          filename: "logo.webp",
          path: "images/logo.webp", // Ruta donde tienes la imagen del logo en tu servidor
          cid: "logoImage", // Se usa como referencia en el HTML
        },
        ...(req.file
          ? [
              {
                filename: req.file.filename,
                path: req.file.path,
                cid: "voucherImage",
              },
            ]
          : []),
      ],
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

     <!-- Logo -->
          <div style="margin-bottom: 20px;">
            <img src="cid:logoImage" alt="Logo" style="width: 100px; height: 100px; border-radius: 50%; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          </div>

  <p style="margin-top: 20px;">Holaa, ¡Gracias por tu compra! ${
    activeRaffle.name
  } 🎉</p>
  <h2 style="color: #4CAF50;">✅ ¡Tu ticket ha sido aprobado!</h2>


       <p><strong>📧 Correo asociado:</strong> ${ticket?.email}</p>
       <p><strong>📅 Fecha de aprobación:</strong> ${new Date().toLocaleDateString(
         "es-ES",
         { weekday: "long", year: "numeric", month: "long", day: "numeric" }
       )}</p>

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
        <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank" style="text-decoration: none;">
          <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
        </a>
      </div>
  </div>
  
  `,
  attachments: [
    {
      filename: "logo.webp",
      path: "images/logo.webp", // Ruta donde tienes la imagen del logo en tu servidor
      cid: "logoImage", // Se usa como referencia en el HTML
    }
  ],
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

// 📌 Endpoint para rechazar ticket
app.post("/api/tickets/reject/:id", async (req, res) => {
  try {
    const ticket = await Ticket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ error: "Ticket no encontrado" });

    const activeRaffle = await Raffle.findOne();

    // Guardar el correo antes de eliminar el ticket
    const userEmail = ticket.email;

    // Eliminar el ticket de la base de datos
    await Ticket.findByIdAndDelete(req.params.id);

    const mailOptions = {
      from: process.env.EMAIL,
      to: userEmail,
      subject: "❌ Ticket de Rifa Rechazado",
      html: `
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; border: 1px solid #ddd;">

      <!-- Logo -->
          <div style="margin-bottom: 20px;">
            <img src="cid:logoImage" alt="Logo" style="width: 100px; height: 100px; border-radius: 50%; box-shadow: 0px 4px 8px rgba(0, 0, 0, 0.1);">
          </div>

        <h2 style="color: #FF0000;">❌ Tu ticket ha sido rechazado</h2>
        <p>Hola, lamentamos informarte que tu solicitud de ticket para la rifa ${activeRaffle.name} ha sido rechazada.</p>
        <p>Si crees que esto es un error, por favor contacta con nuestro equipo de soporte.</p>
        <p><strong>📧 Correo de contacto: </strong>${process.env.EMAIL}</p>
        <p><strong>📲 Numero de contacto: </strong>${process.env.PHONE_NUMBER}</p>
        <p style="text-align: center; margin-top: 30px;"><strong>Saludos,</strong><br>Equipo de Denilson Bastidas</p>

        <p style="font-size: 14px; color: #666;">📲 ¡Síguenos en nuestras redes sociales!</p>
        <div style="justify-content: center; gap: 15px; margin: 0px;">
          <a href="https://www.tiktok.com/@denilsonbastidas_" target="_blank" style="text-decoration: none;">
            <img src="https://cdn-icons-png.flaticon.com/512/3046/3046122.png" alt="TikTok" width="32" height="32">
          </a>
          <a href="https://www.instagram.com/denilsonbastidas" target="_blank" style="text-decoration: none;">
            <img src="https://cdn-icons-png.flaticon.com/512/2111/2111463.png" alt="Instagram" width="32" height="32">
          </a>
          <a href="https://www.facebook.com/profile.php?id=61573705346985" target="_blank" style="text-decoration: none;">
            <img src="https://cdn-icons-png.flaticon.com/512/733/733547.png" alt="Facebook" width="32" height="32">
          </a>
        </div>
      </div>
      `,
      attachments: [
        {
          filename: "logo.webp",
          path: "images/logo.webp", // Ruta donde tienes la imagen del logo en tu servidor
          cid: "logoImage", // Se usa como referencia en el HTML
        }
      ],
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: "Ticket rechazado y correo enviado" });
  } catch (error) {
    console.error("Error al rechazar el ticket:", error);
    res.status(500).json({ error: "Error al rechazar el ticket" });
  }
});

// 📌 Endpoint para obtener todos los tickets
app.get("/api/tickets", async (req, res) => {
  try {
    const tickets = await Ticket.find().sort({ createdAt: 1 });

    // Agregar la URL completa de la imagen
    const ticketsWithImageURL = tickets.map((ticket) => ({
      ...ticket._doc, // Copia todos los datos originales del ticket
      voucher: ticket.voucher
        ? `${req.protocol}://${req.get("host")}/uploads/${ticket.voucher}`
        : null,
    }));

    res.json(ticketsWithImageURL);
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
app.post("/api/admin/auth", async (req, res) => {
  const { token } = req.body;
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "denied" });
  }

  res.json({ message: "Success", token: process.env.ADMIN_SECRET });
});

// Servir imágenes subidas
app.use("/uploads", express.static("uploads"));

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
