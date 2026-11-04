# Backend de rifas

## Modelo y ciclo de vida

- Se pueden crear varias rifas activas simultaneamente.
- Cada compra pertenece obligatoriamente a una rifa mediante `raffleId`.
- Las consultas, numeros, pagos, ranking, aprobaciones y correos se limitan a esa rifa.
- Cada rifa tiene 10.000 numeros (`0000` a `9999`). Un numero puede repetirse en otra rifa, pero no dentro de la misma.
- `visible` solo controla la disponibilidad publica de una rifa activa; no significa que este cerrada.
- Cerrar cambia `status` a `closed` y guarda `closedAt`. Primero deben aprobarse o rechazarse todas las compras pendientes.
- No existe eliminacion de rifas. Las compras rechazadas tambien se conservan, pero no reservan numeros ni cuentan en ventas.
- Una rifa cerrada es inmutable. Se permiten consultas y reenvios administrativos de boletos ya aprobados, usando siempre el nombre de la rifa original.

## Configuracion

Se usan las variables existentes `MONGO_URI`, `ADMIN_SECRET`, `BREVO_API_KEY` y opcionalmente `PORT`.
Usar `.env.example` solo como plantilla local: no contiene valores de produccion. En Railway, configurar las variables en el servicio, sin subir `.env` a Git.
Conservar exactamente la URI y el nombre de base de datos existentes para no iniciar con una base vacia. `ADMIN_SECRET` es el token de acceso actual del panel; no se necesita cambiarlo para esta actualizacion.
`MAX_CODES` ya no se usa: cada rifa tiene 10.000 numeros. `PHONE_NUMBER` no participa en el flujo actual.
MongoDB debe ser un **replica set** o un cluster Atlas: las compras, aprobaciones, ediciones y cierres usan transacciones para evitar carreras.
La asignacion de numeros es aleatoria, sin numeros preferidos.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd start
```

Las pruebas levantan un replica set efimero local con `mongodb-memory-server`, sin conectarse a la base configurada en `.env` y sin enviar correos reales.
La primera ejecucion puede descargar el binario de MongoDB.

## Despliegue y migracion

1. Hacer una copia de seguridad de MongoDB y detener temporalmente las compras. No ejecutar dos versiones del backend durante la migracion.
2. Desplegar backend y frontend de forma coordinada: las peticiones antiguas sin `raffleId` ya no son validas.
   Conservar `master` como rama del servicio Railway y rama de produccion Vercel. No es necesario cambiar de rama para esta actualizacion.
   Railway: instalar con `npm ci --omit=dev` e iniciar con `npm start`; no ejecutar las pruebas contra produccion.
   Vercel: configurar `VITE_API_URL` con la URL publica HTTPS del backend (sin `/api` ni barra final), instalar con `npm ci`, compilar con `npm run build` y publicar `dist`. Cualquier cambio de `VITE_API_URL` requiere un nuevo build.
3. Al iniciar, el backend asigna las compras antiguas sin `raffleId` a la unica rifa existente y marca las rifas antiguas sin estado como activas. No altera numeros, fechas, comprobantes ni pagos.
4. Si hay compras sin rifa y existen cero o varias rifas, el inicio se detiene sin asignarlas arbitrariamente. Revisar la copia y el origen de los datos. Solo si **todas** esas compras pertenecen a una rifa existente:

   ```powershell
   npm.cmd run migrate -- --raffle-id ID_DE_LA_RIFA
   ```

   Si pertenecen a distintas rifas, deben clasificarse y asignarse individualmente antes de iniciar. El comando anterior no puede inferir esa relacion.
5. La migracion es idempotente. Despues se crean los indices, incluyendo la unicidad de numeros aprobados por rifa. Si hay duplicados previos, el inicio se detiene: revisarlos, no borrar compras para ocultar el error.
6. Verificar ventas, consultas y correos de la rifa existente antes de habilitar compras. Desde el panel puede cerrarse y crearse otra inmediatamente, conservando el historial.

Esta migracion no recupera rifas o compras que ya hayan sido eliminadas por versiones anteriores; para ello se necesita una copia de seguridad.

## Contrato de API

- `GET /api/raffles`: devuelve `{ raffles: [...] }`, con estado, imagenes, premios y totales **por rifa**. Las ocultas solo se incluyen para administradores.
- `POST /api/raffles`: crea otra rifa activa.
- `PUT /api/raffles?raffleId=ID`: edita una rifa activa.
- `POST /api/raffles/toggle-visibility?raffleId=ID`: muestra u oculta una activa.
- `POST /api/raffles/close?raffleId=ID`: cierra sin borrar datos.
- Todas las rutas de tickets requieren `raffleId` como query o en el cuerpo de la compra. Los IDs de ticket tambien deben pertenecer a la rifa indicada.
- Las operaciones administrativas de rifas y tickets requieren `Authorization: Bearer <ADMIN_SECRET>`. Comprar y consultar numeros no requieren autenticacion.
- Una aprobacion cuyo correo falla responde `502` con `approved: true`: los numeros ya estan guardados. Debe reenviarse el correo, no aprobarse otra vez.
