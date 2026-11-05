# Backend de una sola rifa

Se restauro el funcionamiento anterior a multiples rifas (base `08f9803`):

- Solo puede existir una rifa. No hay historial, cierre ni cola de correos.
- Las compras y consultas no requieren `raffleId`.
- Rechazar elimina la compra. Eliminar la rifa desde el panel elimina sus tickets, como antes. Esta accion es destructiva.
- Aprobar y reenviar esperan la respuesta del proveedor de correo, como en la version original.
- Se conservan las variables existentes `MONGO_URI`, `ADMIN_SECRET`, `BREVO_API_KEY`, `MAX_CODES` y `PORT`. Si `MONGO_URI` no esta definida, el servidor conserva su configuracion previa. No publicar credenciales.

## Compatibilidad con la base migrada

Revertir Git no revierte MongoDB. No se borraron datos de produccion durante esta restauracion. Los campos `raffleId`, `status`, `emailDelivery`, los indices nuevos y la coleccion `deletedtickets` pueden seguir presentes, pero esta version no crea historial ni auditorias nuevas.

Los rechazados guardados por la version de multiples rifas se excluyen de consultas, totales y acciones para que no reaparezcan. Las compras aprobadas, sus numeros y comprobantes se conservan; una compra eliminada antes de esta restauracion no se recupera automaticamente desde auditoria.

Antes de escuchar peticiones, el servidor comprueba que no haya multiples rifas, una cerrada, compras asociadas a otra rifa ni correos pendientes de la cola anterior. Si detecta una incompatibilidad, se detiene explicitamente sin modificar datos.

Desplegar backend y frontend de `master` juntos y hacer copia de seguridad antes. No limpiar indices ni campos manualmente sin respaldo. Si hay correos pendientes, dejar que la version con cola los termine antes de cambiar. Eliminar completamente los metadatos residuales es una operacion distinta y requiere autorizacion.

## Validacion

`npm.cmd test` ejecuta pruebas aisladas con un replica set efimero, sin tocar la base configurada ni enviar correos reales. Cubre datos migrados, compras nuevas sin rifa, aprobacion, edicion, rechazo, totales, consulta, eliminacion de la rifa y las condiciones de inicio.
