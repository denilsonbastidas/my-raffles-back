const net = require("net");

function checkPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on("connect", () => {
      console.log(`✅ Conectado a ${host}:${port}`);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      console.log(`❌ No se pudo conectar a ${host}:${port}`);
      resolve(false);
    });

    socket.on("timeout", () => {
      console.log(`⏳ Timeout en ${host}:${port}`);
      resolve(false);
    });

    socket.connect(port, host);
  });
}

async function runChecks() {
  await checkPort("smtp.gmail.com", 587);
  await checkPort("smtp.gmail.com", 465);
  await checkPort("smtp.gmail.com", 25);
}

module.exports = runChecks;
