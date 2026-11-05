// ─────────────────────────────────────────
// 0. SUPABASE (conexión, login y guardado)
// ─────────────────────────────────────────

// La conexión (db) se crea en config.js

let usuarioActual = null;  // { id, email, nombre, rol }
let pedidosHoy = [];       // filas de hoy (todos los colegios)

function hoyArgentina() {
  // Fecha de hoy en formato AAAA-MM-DD, hora de Buenos Aires
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
}

function escaparHTML(t) {
  return String(t ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// Mail de quien hizo el pedido de hoy (colegio + proveedor), o null
function quienPidio(colegioId, proveedorId) {
  const r = pedidosHoy.find(x => x.colegio_id === colegioId && x.proveedor_id === proveedorId);
  return r && r.usuario_email ? r.usuario_email : null;
}

async function iniciarSesion(e) {
  if (e) e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const clave = document.getElementById("login-clave").value;
  const err   = document.getElementById("login-error");
  err.innerText = "";
  if (!email || !clave) { err.innerText = "Completá email y contraseña"; return; }

  const { error } = await db.auth.signInWithPassword({ email, password: clave });
  if (error) {
    err.innerText = error.message.includes("Invalid login")
      ? "Email o contraseña incorrectos"
      : "Error: " + error.message;
    return;
  }
  await arrancar();
}

async function cerrarSesion() {
  if (!confirm("¿Querés cerrar sesión?")) return;
  await db.auth.signOut();
  document.getElementById("login-clave").value = "";
  usuarioActual = null;
  colegioActual = null;
  proveedorActual = null;
  pedidos = {};
  historial = [];
  proveedoresPedidos = {};
  pedidosHoy = [];
  document.getElementById("header-der").style.display = "none";
  document.body.classList.remove("es-admin");
  mostrarPantalla("pantalla-login");
}

// Trae de Supabase los pedidos de hoy y reconstruye el historial
async function traerPedidosDeHoy() {
  const { data, error } = await db.from("pedidos_enviados").select("*").eq("fecha", hoyArgentina());
  if (error) {
    console.error(error);
    mostrarToast("⚠️ No se pudieron cargar los pedidos");
    return;
  }
  // Más reciente primero (por la última modificación)
  const ordenados = [...data].sort((a, b) =>
    new Date(b.actualizado_en || b.created_at) - new Date(a.actualizado_en || a.created_at));
  pedidosHoy = ordenados;
  historial = ordenados.map(r => ({
    colegioId: r.colegio_id,
    colegio:   (colegios.find(c => c.id === r.colegio_id)?.nombre || r.colegio_id).toUpperCase(),
    proveedor: proveedoresComunes.find(p => p.id === r.proveedor_id)?.nombre || r.proveedor_id.toUpperCase(),
    contenido: r.contenido,
    modificado: !!(r.actualizado_en && r.created_at &&
                   Math.abs(new Date(r.actualizado_en) - new Date(r.created_at)) > 60000),
    usuario:   r.usuario_email || null,
    hora:      r.actualizado_en
      ? new Date(r.actualizado_en).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" })
      : ""
  }));
}

// Marca en pantalla qué proveedores ya se pidieron / "no pido" en el colegio actual
function aplicarEstadoColegio() {
  pedidos = {};
  proveedoresPedidos = {};
  pedidosHoy.filter(r => r.colegio_id === colegioActual).forEach(r => {
    if (r.estado === "no_pido") pedidos[r.proveedor_id] = [MARCA_NO_PIDO];
    else proveedoresPedidos[r.proveedor_id] = true;
  });
}

// Guarda (o reemplaza) el pedido de hoy de este colegio + proveedor
async function guardarPedido(estado, texto) {
  const { error } = await db.from("pedidos_enviados").upsert({
    fecha:        hoyArgentina(),
    colegio_id:   colegioActual,
    proveedor_id: proveedorActual,
    estado:       estado,
    contenido:    texto
  }, { onConflict: "fecha,colegio_id,proveedor_id" });
  if (error) {
    console.error(error);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────
// 0b. CATÁLOGO DESDE SUPABASE + PANEL DE ADMINISTRACIÓN
// ─────────────────────────────────────────

let catalogoBD = [];          // todas las filas de la tabla productos (incluye ocultos)
let catalogoDesdeBD = false;  // false = se usa el catálogo de respaldo de script.js

// Arma productosPorProveedor (lo que ven los usuarios al pedir) a partir de catalogoBD
function reconstruirCatalogo() {
  const mapa = {};
  catalogoBD.filter(r => r.activo)
    .sort((a, b) => a.orden - b.orden || a.id - b.id)
    .forEach(r => {
      (mapa[r.proveedor_id] = mapa[r.proveedor_id] || []).push(
        { nombre: r.nombre, id: "p" + r.id, tipos: r.tipos, sinStock: r.sin_stock });
    });
  productosPorProveedor = mapa;
}

async function cargarProductos() {
  const { data, error } = await db.from("productos").select("*").order("orden").order("id");
  if (error || !data || data.length === 0) {
    if (error) {
      console.error(error);
      mostrarToast("⚠️ No se pudo cargar el catálogo; se usa una copia guardada");
    }
    catalogoBD = [];
    catalogoDesdeBD = false;
    productosPorProveedor = PRODUCTOS_RESPALDO;
    return;
  }
  catalogoBD = data;
  catalogoDesdeBD = true;
  reconstruirCatalogo();
}

const UNIDADES_COMUNES = ["Unidad", "Display", "Caja", "Bolsa", "Pack", "KG", "Rollo", "Docena", "Porción", "Medio"];
let adminProveedor = null;
let nuevoTipos = ["Unidad"];

function _filasProveedor(pid) {
  return catalogoBD.filter(r => r.proveedor_id === pid).sort((a, b) => a.orden - b.orden || a.id - b.id);
}

function _nombreRepetido(pid, nombre, exceptoId) {
  return catalogoBD.some(r => r.proveedor_id === pid && r.id !== exceptoId && r.nombre === nombre);
}

// Botoncitos de unidades (Unidad, Caja...). "tipos" se modifica en el lugar.
// compacto = true: muestra solo las unidades activas y un botón "Unidades" para editarlas.
function _crearChips(tipos, alCambiar, compacto) {
  const caja = document.createElement("div");
  caja.className = "chips";
  let abierto = !compacto;

  function pintar() {
    caja.innerHTML = "";
    const lista = abierto ? Array.from(new Set([...UNIDADES_COMUNES, ...tipos])) : tipos.slice();
    lista.forEach(t => {
      const chip = document.createElement("span");
      const activo = tipos.includes(t);
      chip.className = "chip" + (activo ? " on" : "") + (abierto ? "" : " fija");
      chip.textContent = t;
      if (abierto) {
        chip.addEventListener("click", () => {
          const i = tipos.indexOf(t);
          if (i >= 0) {
            if (tipos.length === 1) return alert("El producto necesita al menos una unidad");
            tipos.splice(i, 1);
          } else {
            tipos.push(t);
          }
          pintar();
          alCambiar(tipos.slice());
        });
      }
      caja.appendChild(chip);
    });

    if (abierto) {
      const otra = document.createElement("input");
      otra.type = "text";
      otra.placeholder = "Otra unidad";
      otra.className = "chip-otra";
      const mas = document.createElement("span");
      mas.className = "chip mas";
      mas.textContent = "+";
      const agregar = () => {
        const v = otra.value.trim();
        if (!v) return;
        if (!tipos.some(x => x.toLowerCase() === v.toLowerCase())) tipos.push(v.charAt(0).toUpperCase() + v.slice(1));
        pintar();
        alCambiar(tipos.slice());
      };
      mas.addEventListener("click", agregar);
      otra.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); agregar(); } });
      caja.appendChild(otra);
      caja.appendChild(mas);
    }

    if (compacto) {
      const ed = document.createElement("span");
      ed.className = "chip edit";
      ed.textContent = abierto ? "Listo" : "✎ Unidades";
      ed.addEventListener("click", () => { abierto = !abierto; pintar(); });
      caja.appendChild(ed);
    }
  }
  pintar();
  return caja;
}

function _switch(texto, valor, alCambiar) {
  const lab = document.createElement("label");
  lab.className = "admin-switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = valor;
  cb.addEventListener("change", async () => {
    const ok = await alCambiar(cb.checked);
    if (ok === false) cb.checked = !cb.checked;
  });
  lab.appendChild(cb);
  lab.appendChild(document.createTextNode(" " + texto));
  return lab;
}

function _btnIcono(texto, alClick, deshabilitado, clase) {
  const b = document.createElement("button");
  b.className = "btn-icono" + (clase ? " " + clase : "");
  b.textContent = texto;
  b.disabled = !!deshabilitado;
  b.addEventListener("click", alClick);
  return b;
}

function _cardAdmin(r, idx, total, hayFiltro) {
  const div = document.createElement("div");
  div.className = "producto admin-card" + (r.activo ? "" : " oculto");

  const nombre = document.createElement("input");
  nombre.type = "text";
  nombre.className = "admin-nombre";
  nombre.value = r.nombre;
  nombre.addEventListener("change", async () => {
    const v = nombre.value.trim().toUpperCase();
    if (!v) { nombre.value = r.nombre; return; }
    if (v !== r.nombre && _nombreRepetido(r.proveedor_id, v, r.id)) {
      alert("Ya hay un producto con ese nombre en este proveedor");
      nombre.value = r.nombre;
      return;
    }
    nombre.value = v;
    if (v !== r.nombre) await adminGuardar(r, { nombre: v });
  });
  div.appendChild(nombre);

  div.appendChild(_crearChips(r.tipos.slice(), nuevos => adminGuardar(r, { tipos: nuevos }), true));

  const fila = document.createElement("div");
  fila.className = "admin-fila";
  fila.appendChild(_switch("Sin stock", r.sin_stock, marcado => adminGuardar(r, { sin_stock: marcado })));
  fila.appendChild(_switch("Oculto", !r.activo, async marcado => {
    const ok = await adminGuardar(r, { activo: !marcado });
    if (ok) div.classList.toggle("oculto", marcado);
    return ok;
  }));
  if (!hayFiltro) {
    fila.appendChild(_btnIcono("▲", () => adminMover(r, -1), idx === 0));
    fila.appendChild(_btnIcono("▼", () => adminMover(r, +1), idx === total - 1));
  }
  fila.appendChild(_btnIcono("🗑", () => adminBorrar(r), false, "btn-borrar"));
  div.appendChild(fila);
  return div;
}

function renderAdmin() {
  const cont = document.getElementById("admin-lista");
  const filtro = document.getElementById("admin-buscar").value.trim().toLowerCase();
  const filas = _filasProveedor(adminProveedor);
  const visibles = filas.filter(r => !filtro || r.nombre.toLowerCase().includes(filtro));

  renderAdminResumen();

  cont.innerHTML = "";
  if (!visibles.length) {
    cont.innerHTML = `<p style="text-align:center;color:#999;">No hay productos para mostrar.</p>`;
    return;
  }
  visibles.forEach(r => cont.appendChild(_cardAdmin(r, filas.indexOf(r), filas.length, !!filtro)));
}

function _montarNuevoChips() {
  nuevoTipos = ["Unidad"];
  const caja = document.getElementById("nuevo-chips");
  caja.innerHTML = "";
  caja.appendChild(_crearChips(nuevoTipos, () => {}));
}

async function verAdmin() {
  if (!usuarioActual || usuarioActual.rol !== "admin") return;
  await cargarProductos();

  const aviso = document.getElementById("admin-aviso");
  const panel = document.getElementById("admin-panel");
  if (!catalogoDesdeBD) {
    aviso.innerHTML = `<div class="aviso-admin">⚠️ Todavía no está creada la tabla de productos en Supabase (o está vacía). Ejecutá el archivo productos_supabase.sql en el Editor SQL de Supabase y volvé a entrar a esta pantalla.</div>`;
    panel.style.display = "none";
    mostrarPantalla("pantalla-admin");
    return;
  }
  aviso.innerHTML = "";
  panel.style.display = "";

  const sel = document.getElementById("admin-proveedor");
  if (!sel.options.length) {
    proveedoresComunes.filter(p => p.id !== "todo_dulce").forEach(p => sel.add(new Option(p.nombre, p.id)));
    _montarNuevoChips();
  }
  if (!adminProveedor) adminProveedor = sel.value;
  sel.value = adminProveedor;
  document.getElementById("admin-buscar").value = "";
  renderAdmin();
  mostrarPantalla("pantalla-admin");
}

function adminCambiarProveedor() {
  adminProveedor = document.getElementById("admin-proveedor").value;
  document.getElementById("admin-buscar").value = "";
  renderAdmin();
}

function adminBuscar() { renderAdmin(); }

// Guarda cambios de un producto en la base (la base solo lo permite al administrador)
async function adminGuardar(r, cambios) {
  const { error } = await db.from("productos").update(cambios).eq("id", r.id);
  if (error) {
    console.error(error);
    mostrarToast("⚠️ No se pudo guardar el cambio");
    return false;
  }
  Object.assign(r, cambios);
  reconstruirCatalogo();
  renderAdminResumen();
  mostrarToast("Guardado ✅");
  return true;
}

function renderAdminResumen() {
  const filas = _filasProveedor(adminProveedor);
  const n = filas.length;
  const o = filas.filter(r => !r.activo).length;
  const ss = filas.filter(r => r.sin_stock).length;
  document.getElementById("admin-resumen").innerText =
    `${n} producto${n === 1 ? "" : "s"} · ${o} oculto${o === 1 ? "" : "s"} · ${ss} sin stock`;
}

async function adminMover(r, delta) {
  const filas = _filasProveedor(adminProveedor);
  const i = filas.indexOf(r), j = i + delta;
  if (j < 0 || j >= filas.length) return;
  const otro = filas[j];
  const [o1, o2] = [r.orden, otro.orden];
  const [a, b] = await Promise.all([
    db.from("productos").update({ orden: o2 }).eq("id", r.id),
    db.from("productos").update({ orden: o1 }).eq("id", otro.id)
  ]);
  if (a.error || b.error) {
    console.error(a.error || b.error);
    mostrarToast("⚠️ No se pudo cambiar el orden");
    await cargarProductos();
    renderAdmin();
    return;
  }
  r.orden = o2;
  otro.orden = o1;
  reconstruirCatalogo();
  renderAdmin();
}

async function adminBorrar(r) {
  if (!confirm(`¿Borrar "${r.nombre}" del catálogo?\n\nSi solo querés que no se pueda pedir por ahora, usá "Sin stock" u "Oculto".`)) return;
  const { error } = await db.from("productos").delete().eq("id", r.id);
  if (error) {
    console.error(error);
    return mostrarToast("⚠️ No se pudo borrar");
  }
  catalogoBD = catalogoBD.filter(x => x.id !== r.id);
  reconstruirCatalogo();
  renderAdmin();
  mostrarToast("Producto borrado");
}

async function adminAgregar() {
  const inp = document.getElementById("nuevo-nombre");
  const nombre = inp.value.trim().toUpperCase();
  if (!nombre) return alert("Escribí el nombre del producto");
  if (_nombreRepetido(adminProveedor, nombre, null)) return alert("Ya hay un producto con ese nombre en este proveedor");

  const orden = Math.max(0, ..._filasProveedor(adminProveedor).map(r => r.orden)) + 1;
  const { data, error } = await db.from("productos")
    .insert({ proveedor_id: adminProveedor, nombre, tipos: nuevoTipos.slice(), orden })
    .select().single();
  if (error) {
    console.error(error);
    return mostrarToast("⚠️ No se pudo agregar el producto");
  }
  catalogoBD.push(data);
  reconstruirCatalogo();
  inp.value = "";
  _montarNuevoChips();
  document.getElementById("admin-buscar").value = "";
  renderAdmin();
  mostrarToast("Producto agregado ✅");
}

// Punto de entrada: ve si hay sesión iniciada
async function arrancar() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) { mostrarPantalla("pantalla-login"); return; }

  const { data: perfil } = await db.from("perfiles").select("*").eq("id", session.user.id).single();
  usuarioActual = {
    id:     session.user.id,
    email:  session.user.email,
    nombre: perfil?.nombre || null,
    rol:    perfil?.rol || "usuario"
  };

  document.getElementById("header-der").style.display = "";
  const esAdmin = usuarioActual.rol === "admin";
  document.getElementById("btn-admin").style.display = esAdmin ? "" : "none";
  document.body.classList.toggle("es-admin", esAdmin);
  await cargarProductos();
  renderColegios();
  mostrarPantalla("pantalla-colegios");
}

const MARCA_NO_PIDO = "NO_PIDO";
let colegioActual = null;
let proveedorActual = null;
let pedidos = {};
let historial = [];
let proveedoresPedidos = {}; // persiste el estado "pedido" aunque se vacíe el carrito

// ─────────────────────────────────────────
// 1. DATOS
// ─────────────────────────────────────────

const colegios = [
  { id: "defensa",  nombre: "Defensa" },
  { id: "naval",   nombre: "Naval" },
  { id: "grierson",nombre: "Grierson" },
  { id: "tosco",   nombre: "Tosco" },
  { id: "lorca",   nombre: "Lorca" }
];

// Color de cada colegio (para cambiar uno, se modifica solo el código de acá)
const COLORES_COLEGIO = {
  defensa:  "#2563EB",  // azul
  naval:    "#0E7490",  // turquesa
  grierson: "#7C3AED",  // violeta
  tosco:    "#DB2777",  // rosa
  lorca:    "#8B5E3C"   // café
};
function colorColegio(id) { return COLORES_COLEGIO[id] || "#ff6a00"; }

// Tono muy suave del color del colegio (se mezcla con el gris de fondo) para pintar la pantalla
function tinteColegio(hex, p) {
  const n = i => parseInt(hex.slice(i, i + 2), 16);
  const base = 246;
  const m = v => Math.round(base + (v - base) * p);
  return `rgb(${m(n(1))}, ${m(n(3))}, ${m(n(5))})`;
}

const proveedoresComunes = [
  { id: "distrizorz",         nombre: "DISTRIZORZ" },
  { id: "arcor_golosinas",    nombre: "ARCOR GOLOSINAS" },
  { id: "arcor_chocolates",   nombre: "ARCOR CHOCOLATES" },
  { id: "deposito_cafeteria", nombre: "DEPÓSITO GM — CAFETERÍA" },
  { id: "deposito_papelera",  nombre: "DEPÓSITO GM — PAPELERA" },
  { id: "deposito_varios",    nombre: "DEPÓSITO GM — VARIOS" },
  { id: "osvaldo",            nombre: "OSVALDO" },
  { id: "coca_cola",          nombre: "COCA COLA" },
  { id: "rasta",              nombre: "RASTA ALFAJORES" },
  { id: "quento",             nombre: "QUENTO" },
  { id: "kaba",               nombre: "KABA CONGELADOS" },
  { id: "citric",             nombre: "CITRIC" },
  { id: "sm_alimentos",       nombre: "SM ALIMENTOS" },
  { id: "la_alimenticia",     nombre: "LA ALIMENTICIA (SOBRES)" },
  { id: "milkaut",            nombre: "MILKAUT" },
  { id: "distrimax",          nombre: "DISTRIMAX" },
  { id: "fiambreria",         nombre: "FIAMBRERÍA" },
  { id: "avimas",             nombre: "AVIMAS" },
  { id: "ailutap",            nombre: "AILUTAP" },
  { id: "dietetica",          nombre: "DIETÉTICA" },
  { id: "marilu",             nombre: "MARILÚ" },
  { id: "grado_cero",         nombre: "GRADO CERO" },
  { id: "reparto_gm",         nombre: "REPARTO GM" },
  { id: "makro",              nombre: "MAKRO" },
  { id: "verduleria",         nombre: "VERDULERÍA" },
  { id: "todo_dulce",         nombre: "TODO DULCE" }
];

let proveedoresPorColegio = {};
colegios.forEach(c => { proveedoresPorColegio[c.id] = proveedoresComunes; });

const agendaPrioridades = {
  defensa: { 1: "distrizorz", 3: "arcor_golosinas", 5: "arcor_chocolates" },
  naval:   { 2: "distrizorz", 4: "arcor_chocolates" }
};

const PRODUCTOS_RESPALDO = {
  arcor_golosinas: [
    { nombre: "MOGUL TUBITOS 15G",                    id: "mogul_tub_15",        tipos: ["Unidad","Display"] },
    { nombre: "MOGUL PIECITOS 30G",                   id: "mogul_pie_30",        tipos: ["Unidad","Display"] },
    { nombre: "MOGUL ROLLO FRUTAL",                   id: "mogul_rollo_frut",    tipos: ["Unidad","Display"] },
    { nombre: "MOGUL ROLLO ÁCIDO",                    id: "mogul_rollo_acido",   tipos: ["Unidad","Display"] },
    { nombre: "MOGUL PALOTES TUTTI/BLUE",             id: "mogul_pal_tutti",     tipos: ["Unidad","Display"] },
    { nombre: "MOGUL PALOTES SANDÍA/LIMÓN",           id: "mogul_pal_sand",      tipos: ["Unidad","Display"] },
    { nombre: "MOGUL EXTREME ROCKS 45G",              id: "mogul_rocks_45",      tipos: ["Unidad"] },
    { nombre: "MOGUL JELLY BEANS 50G",                id: "mogul_jelly_50",      tipos: ["Unidad"] },
    { nombre: "CHUPETIN MR POPS",                     id: "mrpops",              tipos: ["Unidad","Bolsa"] },
    { nombre: "JUGO ARCOR SOBRE NARANJA",             id: "jugo_arc_naran",      tipos: ["Unidad"] },
    { nombre: "JUGO ARCOR SOBRE DURAZNO",             id: "jugo_arc_duraz",      tipos: ["Unidad"] },
    { nombre: "CARAMELOS BUTTERTOFFY CHOCO",          id: "buttertoffy_choco",   tipos: ["Unidad","Bolsa"] },
    { nombre: "CARAMELOS BUTTERTOFFY DDL",            id: "buttertoffy_ddl",     tipos: ["Unidad","Bolsa"] },
    { nombre: "TURRON ARCOR",                         id: "turron_arcor",        tipos: ["Unidad","Display"] },
    { nombre: "TRAVIATA KESITAS 96G",                 id: "trav_kesitas_96",     tipos: ["Unidad","Caja"] },
    { nombre: "TRAVIATA REX 96G",                     id: "trav_rex_96",         tipos: ["Unidad","Caja"] },
    { nombre: "REX CAJA 125G",                        id: "rex_caja_125",        tipos: ["Caja"] },
    { nombre: "KESITAS CAJA 125G",                    id: "kesitas_caja_125",    tipos: ["Caja"] },
    { nombre: "REX BOLSA 75G",                        id: "rex_bolsa_75",        tipos: ["Bolsa"] },
    { nombre: "KESITAS BOLSA 75G",                    id: "kesitas_bolsa_75",    tipos: ["Bolsa"] },
    { nombre: "GALLETITAS MERENGADAS 100G",           id: "gal_merengadas",      tipos: ["Unidad"] },
    { nombre: "GALLETITAS SONRISAS 100G",             id: "gal_sonrisas",        tipos: ["Unidad"] },
    { nombre: "GALLETITAS RUMBA 100G",                id: "gal_rumba",           tipos: ["Unidad"] },
    { nombre: "GALLETITAS MELLIZAS 100G",             id: "gal_mellizas",        tipos: ["Unidad"] },
    { nombre: "GALLETITAS AMOR 100G",                 id: "gal_amor",            tipos: ["Unidad"] },
    { nombre: "MENTHOPLUS STRONG",                    id: "mentho_strong",       tipos: ["Unidad","Display"] },
    { nombre: "MENTHOPLUS CHERRY",                    id: "mentho_cherry",       tipos: ["Unidad","Display"] },
    { nombre: "MENTHOPLUS MIEL",                      id: "mentho_miel",         tipos: ["Unidad","Display"] },
    { nombre: "MENTHOPLUS MENTA",                     id: "mentho_menta",        tipos: ["Unidad","Display"] },
    { nombre: "GALLETITAS OPERA 55G",                 id: "gal_opera_55",        tipos: ["Unidad"] },
    { nombre: "CARAMELOS RELLENOS MIEL",              id: "caram_miel",          tipos: ["Unidad","Bolsa"] },
    { nombre: "CARAMELO MENTA CRISTAL",               id: "caram_menta_crist",   tipos: ["Unidad","Bolsa"] },
    { nombre: "JUGO ARCOR NARANJA 200ML",             id: "jugo_liq_naran",      tipos: ["Unidad"] },
    { nombre: "JUGO ARCOR MANZANA 200ML",             id: "jugo_liq_manz",       tipos: ["Unidad"] },
    { nombre: "JUGO ARCOR MULTIFRUTA 200ML",          id: "jugo_liq_multi",      tipos: ["Unidad"] },
    { nombre: "GALLETITAS TRAVIATA 108G",             id: "traviata_108",        tipos: ["Unidad"] },
    { nombre: "LOTZA FIZZ",                           id: "lotza_fizz",          tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR CHOCOTORTA",                   id: "alf_chocotorta",      tipos: ["Unidad","Caja"] }
  ],
  arcor_chocolates: [
    { nombre: "CHOCOLATIN ARCOR BLANCO 8G",                id: "choc_blanco_8g",      tipos: ["Unidad","Display"] },
    { nombre: "CHOCOLATIN ARCOR NEGRO 8G",                 id: "choc_negro_8g",       tipos: ["Unidad","Display"] },
    { nombre: "BON O BON",                                 id: "bonobon",             tipos: ["Unidad","Bolsa"] },
    { nombre: "ALFAJOR BONOBON SIMPLE",                    id: "alf_bonobon_simp",    tipos: ["Unidad","Caja"] },
    { nombre: "BARRITA CEREAL MIX CLASICO",                id: "barrita_mix_clas",    tipos: ["Unidad","Display"] },
    { nombre: "SALADIX PAPAS ORIGINAL 50G",                id: "saladix_papas_50",    tipos: ["Unidad"] },
    { nombre: "SALADIX STICK PICANTE 80G",                 id: "saladix_stick_pic",   tipos: ["Unidad"] },
    { nombre: "SALADIX CROSS PIZZA 67G",                   id: "saladix_pizza_67",    tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX CROSS PIZZA 27G",                   id: "saladix_pizza_27",    tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX CROSS ORIGINAL 67G",                id: "saladix_orig_67",     tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX CROSS ORIGINAL 27G",                id: "saladix_orig_27",     tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX CROSS PICANTE 67G",                 id: "saladix_pic_67",      tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX CROSS PICANTE 27G",                 id: "saladix_pic_27",      tipos: ["Unidad","Caja"] },
    { nombre: "SALADIX ESTUCHE PIZZA 100G",                id: "saladix_est_pizza",   tipos: ["Unidad"] },
    { nombre: "SALADIX ESTUCHE JAMON 100G",                id: "saladix_est_jamon",   tipos: ["Unidad"] },
    { nombre: "SALADIX ESTUCHE SALAME 100G",               id: "saladix_est_salame",  tipos: ["Unidad"] },
    { nombre: "SALADIX ESTUCHE PICANTE 100G",              id: "saladix_est_pic",     tipos: ["Unidad"] },
    { nombre: "SALADIX ESTUCHE DUO 100G",                  id: "saladix_est_duo",     tipos: ["Unidad"] },
    { nombre: "SALADIX BOLSA/SOBRE 40G",                   id: "saladix_bolsa_40",    tipos: ["Bolsa"] },
    { nombre: "ALFAJOR BLOCK TRIPLE",                      id: "alf_block_trip",      tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR BONOBON TRIPLE",                    id: "alf_bonobon_trip",    tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR AGUILA MINITORTA CLÁSICO",          id: "alf_aguila_clas",     tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR AGUILA MINITORTA BROWNIE",          id: "alf_aguila_brown",    tipos: ["Unidad","Caja"] },
    { nombre: "GALLETITAS FORMIS ANIMALITOS DDL 72G",      id: "formis_ddl_72",       tipos: ["Unidad"] },
    { nombre: "GALLETITAS FORMIS ANIMALITOS FRUTILLA 72G", id: "formis_frut_72",      tipos: ["Unidad"] },
    { nombre: "GALLETITAS TORTITAS BLACK 125G",            id: "tortitas_black_125",  tipos: ["Unidad"] },
    { nombre: "GALLETITAS CEREAL MIX AVENA 207G",          id: "cereal_mix_avena",    tipos: ["Unidad"] },
    { nombre: "GALLETITAS FORMIS ANIMALES 102G",           id: "formis_anim_102",     tipos: ["Unidad"] },
    { nombre: "ROCKLETS 20G",                              id: "rocklets_20",         tipos: ["Unidad","Display"] }
  ],
  distrizorz: [
    { nombre: "BULLDOG REGALIZ 18G",                   id: "bulldog_reg_18",       tipos: ["Unidad","Bolsa"] },
    { nombre: "VAUQUITA",                              id: "vauquita",             tipos: ["Unidad","Display"] },
    { nombre: "GALLETITAS MACUCAS 110G",               id: "macucas_110",          tipos: ["Unidad"] },
    { nombre: "GALLETITAS MACUCAS 85G",                id: "macucas_85",           tipos: ["Unidad"] },
    { nombre: "GALLETITAS CEREALITAS CLASICAS 207G",   id: "cerealitas_207",       tipos: ["Unidad"] },
    { nombre: "MASTICABLE MISKY",                      id: "misky_mast",           tipos: ["Unidad","Bolsa"] },
    { nombre: "GALLETITAS MEDIATARDE",                 id: "mediatarde",           tipos: ["Unidad"] },
    { nombre: "RHODESIA",                              id: "rhodesia",             tipos: ["Unidad","Caja"] },
    { nombre: "SUGUS MAX",                             id: "sugus_max",            tipos: ["Unidad","Display"] },
    { nombre: "SUGUS CONFITADOS",                      id: "sugus_conf",           tipos: ["Unidad","Bolsa"] },
    { nombre: "GALLETITAS VOCACION",                   id: "vocacion",             tipos: ["Unidad"] },
    { nombre: "GALLETITAS VOCACION ACARAMELADAS",      id: "vocacion_acar",        tipos: ["Unidad"] },
    { nombre: "GALLETITAS MINIOREO 50G",               id: "minioreo_50",          tipos: ["Unidad"] },
    { nombre: "DON SATUR BIZCOCHITOS",                 id: "don_satur",            tipos: ["Unidad","Bolsa"] },
    { nombre: "SAPITO 11G",                            id: "sapito_11",            tipos: ["Unidad","Display"] },
    { nombre: "MISKY FRUTTIGELATIN",                   id: "misky_frut",           tipos: ["Unidad","Bolsa"] },
    { nombre: "TURRON NEVARES",                        id: "turron_nev",           tipos: ["Unidad","Display"] },
    { nombre: "MENTITAS",                              id: "mentitas",             tipos: ["Unidad","Display"] },
    { nombre: "LEE'S TURRONES CEREAL 70G",             id: "lees_turron_70",       tipos: ["Unidad"] },
    { nombre: "GALLETITAS CLUB SOCIAL",                id: "club_social",          tipos: ["Unidad","Caja"] },
    { nombre: "POW POW LEE'S MAIZ INFLADO",            id: "powpow_tutucas",       tipos: ["Bolsa"] },
    { nombre: "GALLETITAS PEPOS 200G",                 id: "pepos_200",            tipos: ["Unidad"] },
    { nombre: "GALLETITAS CANONCITOS 200G",            id: "canon_200",            tipos: ["Unidad"] },
    { nombre: "HAMLET",                                id: "hamlet",               tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR LA RECOVA",                     id: "alf_recova",           tipos: ["Unidad","Caja"] },
    { nombre: "MASTICABLE BILLIKEN",                   id: "billiken_mast",        tipos: ["Unidad","Bolsa"] },
    { nombre: "TIC TAC",                               id: "tic_tac",              tipos: ["Unidad","Display"] },
    { nombre: "TALITA TOSTEX",                         id: "tostex",               tipos: ["Unidad","Bolsa"] },
    { nombre: "DRF",                                   id: "drf",                  tipos: ["Unidad","Display"] },
    { nombre: "GONGYS 28G",                            id: "gongys_28",            tipos: ["Unidad","Bolsa"] },
    { nombre: "SMACK OBLEA",                           id: "smack_oblea",          tipos: ["Unidad","Display"] },
    { nombre: "SMACK CUBANITO",                        id: "smack_cuba",           tipos: ["Unidad","Display"] },
    { nombre: "GALLETITAS CELOSAS 110G",               id: "celosas_110",          tipos: ["Unidad"] },
    { nombre: "BULLDOG 30G",                           id: "bulldog_30",           tipos: ["Unidad","Bolsa"] },
    { nombre: "ALFAJOR JORGELIN",                      id: "alf_jorgelin",         tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR FANTOCHE TRIPLE",               id: "alf_fantoche_trip",    tipos: ["Unidad","Caja"] },
    { nombre: "GALLETITAS PEPAS TEREPIN 200G",         id: "pepas_terepin_200",    tipos: ["Unidad"] },
    { nombre: "GALLETITAS PEPAS DELICIAS NONA 160G",   id: "pepas_nona_160",       tipos: ["Unidad"] },
    { nombre: "MACRITAS NACHOS KETCHUP 70G",           id: "macritas_nachos_70",   tipos: ["Unidad","Bolsa"] },
    { nombre: "KOOKY BON 10G",                         id: "kooky_bon_10",         tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR JORGITO",                       id: "alf_jorgito",          tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR GUAYMAYEN SIMPLE",              id: "alf_guaym_simp",       tipos: ["Unidad","Caja"] },
    { nombre: "PICO DULCE",                            id: "pico_dulce",           tipos: ["Unidad","Display"] },
    { nombre: "NUGATON",                               id: "nugaton",              tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR CHOCOARROZ",                    id: "alf_chocoarroz",       tipos: ["Unidad","Caja"] },
    { nombre: "TALITAS TOSTI CLÁSICAS",                id: "tosti_clas",           tipos: ["Unidad","Bolsa"] },
    { nombre: "YUMMY 30G",                             id: "yummy_30",             tipos: ["Unidad","Bolsa"] },
    { nombre: "PIC NIC",                               id: "pic_nic",              tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR GUAYMAYEN TRIPLE",              id: "alf_guaym_trip",       tipos: ["Unidad","Caja"] },
    { nombre: "REFRESCO",                              id: "refresco",             tipos: ["Unidad","Display"] },
    { nombre: "GALLO YOGUBAR BARRITA",                 id: "yogubar",              tipos: ["Unidad","Display"] },
    { nombre: "BARRITAS CEREAL FORT",                  id: "barrita_fort",         tipos: ["Unidad","Display"] },
    { nombre: "FEELING",                               id: "feeling",              tipos: ["Unidad","Bolsa"] },
    { nombre: "VIZZIO 35G",                            id: "vizzio_35",            tipos: ["Unidad","Bolsa"] },
    { nombre: "YAPA",                                  id: "yapa",                 tipos: ["Unidad","Display"] },
    { nombre: "PASTAFROLA AIRES DEL LUJAN",            id: "pastafrola_aires",     tipos: ["Unidad"] },
    { nombre: "FLYN PAFF",                             id: "flynpaff",             tipos: ["Unidad","Bolsa"] },
    { nombre: "SMACK BAR",                             id: "smack_bar",            tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR RED VELVET",                    id: "alf_red_velvet",       tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR FANTOCHE SUPER TRIPLE",         id: "alf_fantoche_super",   tipos: ["Unidad","Caja"] }
  ],
  deposito_cafeteria: [
    { nombre: "CHOCOLATE EN POLVO 1KG",          id: "cafe_choco_1kg",    tipos: ["Bolsa"] },
    { nombre: "CAFÉ NESCAFÉ CLÁSICO 1KG",        id: "cafe_nescafe_1kg",  tipos: ["Bolsa"] },
    { nombre: "LECHE EN POLVO SAN REGIM 500G",   id: "cafe_leche_500",    tipos: ["Bolsa"] },
    { nombre: "CAJA EDULCORANTE ENDULCINA",       id: "cafe_edulcor",      tipos: ["Caja"] },
    { nombre: "CAJA AZÚCAR EN SOBRES YAMOA",      id: "cafe_azucar_sob",   tipos: ["Caja"] },
    { nombre: "CÁPSULA BONAFIDE CAFÉ LUNGO",      id: "cafe_cap_lungo",    tipos: ["Unidad"] },
    { nombre: "CÁPSULA COFFEE BREAK C/LECHE",     id: "cafe_cap_cleche",   tipos: ["Unidad"] },
    { nombre: "CÁPSULA COFFEE BREAK CORTADO",     id: "cafe_cap_cortado",  tipos: ["Unidad"] },
    { nombre: "CÁPSULA COFFEE BREAK CAPUCHINO",   id: "cafe_cap_capuche",  tipos: ["Unidad"] },
    { nombre: "CÁPSULA COFFEE BREAK LÁGRIMA",     id: "cafe_cap_lagrima",  tipos: ["Unidad"] },
    { nombre: "CAJITA TÉ EN SOBRES",              id: "cafe_te_sob",       tipos: ["Caja"] },
    { nombre: "CAJITA MATE COCIDO EN SOBRES",     id: "cafe_mate_sob",     tipos: ["Caja"] }
  ],
  deposito_papelera: [
    { nombre: "BIROMES EZKO",                            id: "pap_birome_ezko",    tipos: ["Unidad"] },
    { nombre: "BIROMES BIC",                             id: "pap_birome_bic",     tipos: ["Unidad"] },
    { nombre: "CUCURUCHO PARA FRITAS x500u",             id: "pap_cucurucho",      tipos: ["Pack"] },
    { nombre: "ESTUCHE MICROONDAS TAPA BISAGRA x100u",   id: "pap_estuche_micro",  tipos: ["Pack"] },
    { nombre: "TENEDOR PLÁSTICO x50u",                   id: "pap_tenedor",        tipos: ["Pack"] },
    { nombre: "CUCHILLO PLÁSTICO x50u",                  id: "pap_cuchillo",       tipos: ["Pack"] },
    { nombre: "CUCHARITA PLÁSTICA",                      id: "pap_cucharita",      tipos: ["Pack"] },
    { nombre: "POTE PLÁSTICO ENSALADA FRUTAS 250G",      id: "pap_pote_ensalada",  tipos: ["Pack"] },
    { nombre: "POTE CON TAPA BISAGRA BAJO x100u",        id: "pap_pote_bisagra",   tipos: ["Pack"] },
    { nombre: "TAPA POTE PLÁSTICO ENSALADA 250G",        id: "pap_tapa_pote",      tipos: ["Pack"] },
    { nombre: "PLATO DESCARTABLE BLANCO 22CM x100u",     id: "pap_plato_22",       tipos: ["Pack"] },
    { nombre: "MARCADORES TRABI",                        id: "pap_marc_trabi",     tipos: ["Unidad"] },
    { nombre: "BOLÍGRAFO AZUL EZCO",                     id: "pap_boli_azul",      tipos: ["Unidad"] },
    { nombre: "BOLÍGRAFO NEGRO EZCO",                    id: "pap_boli_negro",     tipos: ["Unidad"] },
    { nombre: "SERVILLETAS ECOROYAL 33X33",              id: "pap_servilletas",    tipos: ["Pack"] },
    { nombre: "PACK x2 ROLLOS BOBINA INDUSTRIAL 25x400", id: "pap_bobina_ind",     tipos: ["Pack"] },
    { nombre: "BANDEJA ALUMINIO REDONDA P20 x100u",      id: "pap_bdj_alum_red",   tipos: ["Pack"] },
    { nombre: "BANDEJA CARTÓN RECT. N°1 x100u",          id: "pap_bdj_cart_1",     tipos: ["Pack"] },
    { nombre: "BANDEJA CARTÓN RECT. N°2 x100u",          id: "pap_bdj_cart_2",     tipos: ["Pack"] },
    { nombre: "BANDEJA CARTÓN N°13 x100u",               id: "pap_bdj_cart_13",    tipos: ["Pack"] },
    { nombre: "FILM ADHERENTE 38CM RESIFILM",            id: "pap_film",           tipos: ["Rollo"] },
    { nombre: "VASOS TÉRMICOS 240CC",                    id: "pap_vaso_240",       tipos: ["Pack"] },
    { nombre: "VASOS TÉRMICOS 180CC",                    id: "pap_vaso_180",       tipos: ["Pack"] },
    { nombre: "VASOS TÉRMICOS 300CC",                    id: "pap_vaso_300",       tipos: ["Pack"] },
    { nombre: "AGITADORES",                              id: "pap_agitadores",     tipos: ["Pack"] },
    { nombre: "FOLEX 20X25",                             id: "pap_folex_20",       tipos: ["Pack"] },
    { nombre: "FOLEX 25X35",                             id: "pap_folex_25",       tipos: ["Pack"] },
    { nombre: "PAPEL SULFITO 50X70CM",                   id: "pap_sulfito",        tipos: ["Pack"] },
    { nombre: "TRÍPODE PARA PIZZA",                      id: "pap_tripode_pizza",  tipos: ["Pack"] },
    { nombre: "VASO PLÁSTICO 220CC BLANCO x100u",        id: "pap_vaso_plast_220", tipos: ["Pack"] },
    { nombre: "VASO PLÁSTICO BLANCO 110CC x100u",        id: "pap_vaso_plast_110", tipos: ["Pack"] },
    { nombre: "BOLSA CAMISETA 20X30 x100u",              id: "pap_bolsa_20x30",    tipos: ["Pack"] },
    { nombre: "BOLSA CAMISETA 30X40 x100u",              id: "pap_bolsa_30x40",    tipos: ["Pack"] },
    { nombre: "BOLSA CAMISETA 45X60",                    id: "pap_bolsa_45x60",    tipos: ["Pack"] },
    { nombre: "BOLSA CAMISETA 50X70",                    id: "pap_bolsa_50x70",    tipos: ["Pack"] },
    { nombre: "BOLSA CAMISETA 60X80 x80u",               id: "pap_bolsa_60x80",    tipos: ["Pack"] },
    { nombre: "BOLSA COMPACTADORA 90X120 x100u",         id: "pap_bolsa_compact",  tipos: ["Pack"] },
    { nombre: "BOLSA CONSORCIO VERDE 80X110 x100u",      id: "pap_bolsa_consorcio",tipos: ["Pack"] },
    { nombre: "MARCADOR PARA PIZARRA",                   id: "pap_marc_pizarra",   tipos: ["Unidad"] },
    { nombre: "BOLSAS KRAFT N°7 x100u",                  id: "pap_kraft_7",        tipos: ["Pack"] },
    { nombre: "BOLSAS KRAFT N°10 x100u",                 id: "pap_kraft_10",       tipos: ["Pack"] },
    { nombre: "BOLSAS KRAFT N°3 x100u",                  id: "pap_kraft_3",        tipos: ["Pack"] },
    { nombre: "BOLSAS KRAFT N°4A x100u",                 id: "pap_kraft_4a",       tipos: ["Pack"] },
    { nombre: "ROLLO ARRANQUE 15x20",                    id: "pap_rollo_15x20",    tipos: ["Rollo"] },
    { nombre: "ROLLO ARRANQUE 20x25",                    id: "pap_rollo_20x25",    tipos: ["Rollo"] },
    { nombre: "ROLLO ARRANQUE 20x30 RENDIDOR",           id: "pap_rollo_20x30",    tipos: ["Rollo"] },
    { nombre: "ROLLO ARRANQUE 25x35 RENDIDOR",           id: "pap_rollo_25x35",    tipos: ["Rollo"] },
    { nombre: "ROLLO ARRANQUE 30x40 RENDIDOR",           id: "pap_rollo_30x40",    tipos: ["Rollo"] },
    { nombre: "ROLLO ARRANQUE 15x25",                    id: "pap_rollo_15x25",    tipos: ["Rollo"] },
    { nombre: "BANDAS ELÁSTICAS x100g",                  id: "pap_bandas_elast",   tipos: ["Pack"] },
    { nombre: "BOLSA POLIPROPILENO 12X20 x100u",         id: "pap_poliprop_12x20", tipos: ["Pack"] },
    { nombre: "BOLSA POLIPROPILENO 8X20 x100u",          id: "pap_poliprop_8x20",  tipos: ["Pack"] },
    { nombre: "CINTA ADHESIVA 12MM x60M",                id: "pap_cinta_12mm",     tipos: ["Unidad"] },
    { nombre: "TACO NOTAS ADHESIVAS 7.5x7.5 x200h",     id: "pap_notas_adh",      tipos: ["Unidad"] },
    { nombre: "TAPA VASO TÉRMICO 240CC x100u",           id: "pap_tapa_240",       tipos: ["Pack"] },
    { nombre: "TAPA VASO TÉRMICO 300CC x100u",           id: "pap_tapa_300",       tipos: ["Pack"] },
    { nombre: "ROLLO BOLSA SELLADO AL VACÍO 20CMx500CM", id: "pap_rollo_vacio",    tipos: ["Rollo"] },
    { nombre: "CASUELA TELGOPOR K63 x100u",              id: "pap_casuela_telg",   tipos: ["Pack"] },
    { nombre: "CUCHARA SOPERA BLANCA x25u",              id: "pap_cuchara_sopera", tipos: ["Pack"] },
    { nombre: "CAJAS EMPANADAS MICROCORRUG. 12u x100u",  id: "pap_caja_empanada",  tipos: ["Pack"] },
    { nombre: "BANDEJA PLÁSTICA 103 FRIO x100u",         id: "pap_bdj_plast_103",  tipos: ["Pack"] },
    { nombre: "GUANTE LÁTEX MEDIANO x100u",              id: "pap_guante_latex",   tipos: ["Pack"] },
    { nombre: "PAÑUELITOS DESCARTABLES 6 PACK",          id: "pap_panuelos",       tipos: ["Pack"] }
  ],
  deposito_varios: [
    { nombre: "JERINGA VENENO MATA CUCARACHAS", id: "var_jeringa_venen", tipos: ["Unidad"] },
    { nombre: "TOALLITAS FEMENINAS 16u",        id: "var_toallitas",     tipos: ["Pack"] },
    { nombre: "POST-IT 38X50",                  id: "var_postit",        tipos: ["Unidad"] },
    { nombre: "TABLETA MOSQUITOS FUYI 24u",     id: "var_tableta_mosq",  tipos: ["Caja"] }
  ],
  osvaldo: [
    { nombre: "COCA 500",                                   id: "osv_coca_500",     tipos: ["Unidad","Pack"] },
    { nombre: "COCA ZERO 500",                              id: "osv_cocazero_500", tipos: ["Unidad","Pack"] },
    { nombre: "AGUA VILLAMANAOS 500ML",                     id: "osv_agua_villa",   tipos: ["Unidad","Pack"] },
    { nombre: "AGUA CON GAS ECO DE LOS ANDES",              id: "osv_agua_gas",     tipos: ["Unidad","Pack"] },
    { nombre: "AGUA TÓNICA CUNNINGTON",                     id: "osv_tonica",       tipos: ["Unidad","Pack"] },
    { nombre: "BAGGIO LATTE 200ML",                        id: "osv_baggio_latte", tipos: ["Unidad","Pack"] },
    { nombre: "BAGGIO NARANJA/MANZANA/MULTIFRUTA 200ML",   id: "osv_baggio_mix",   tipos: ["Unidad","Pack"] },
    { nombre: "PEPSI BLACK 500",                            id: "osv_pepsiblack",   tipos: ["Unidad","Pack"] },
    { nombre: "PEPSI 500",                                  id: "osv_pepsi",        tipos: ["Unidad","Pack"] },
    { nombre: "7UP 500",                                    id: "osv_7up",          tipos: ["Unidad","Pack"] },
    { nombre: "7UP FREE 500",                               id: "osv_7upfree",      tipos: ["Unidad","Pack"] },
    { nombre: "PLACER NARANJA/MANZANA/POMELO 500ML",       id: "osv_placer",       tipos: ["Unidad","Pack"] }
  ],
  coca_cola: [
    { nombre: "AQUARIUS 500",         id: "cc_aquarius", tipos: ["Unidad","Pack"] },
    { nombre: "CEPITA 200",           id: "cc_cepita",   tipos: ["Unidad","Pack"] },
    { nombre: "POWERADE ROJA/AZUL 500",id: "cc_powerade",tipos: ["Unidad","Pack"] },
    { nombre: "COCA 237CC",           id: "cc_coca_237", tipos: ["Unidad","Pack"] }
  ],
  rasta: [
    { nombre: "POCHOCLOS OKKI 70G",        id: "rasta_okki",      tipos: ["Unidad","Display"] },
    { nombre: "ALFAJOR RASTA BLANCO/NEGRO",id: "rasta_alf_bn",    tipos: ["Unidad","Caja"] },
    { nombre: "ALFAJOR RASTA TRICO",       id: "rasta_alf_trico", tipos: ["Unidad","Caja"] }
  ],
  quento: [
    { nombre: "PAPAS QUENTO 45G", id: "quen_papas_45", tipos: ["Unidad","Caja"] }
  ],
  kaba: [
    { nombre: "HELADO FANTOCHE",               id: "kaba_fantoche",     tipos: ["Unidad","Caja"] },
    { nombre: "HELADO BOMBÓN",                 id: "kaba_bombon",       tipos: ["Unidad","Caja"] },
    { nombre: "HELADO BOMBÓN CROC",            id: "kaba_bombon_croc",  tipos: ["Unidad","Caja"] },
    { nombre: "HELADO CABITO COMBINADO (MIXTO)",id: "kaba_cabito_mix",  tipos: ["Unidad","Caja"] },
    { nombre: "HELADO SUMMUN/UP/ZUM",          id: "kaba_summun",       tipos: ["Unidad","Caja"] },
    { nombre: "MEDIALUNA BOMPANING",           id: "kaba_medialuna",    tipos: ["Unidad","Pack"] },
    { nombre: "DONA",                          id: "kaba_dona",         tipos: ["Unidad","Pack"] },
    { nombre: "HELADO CABITO GRANIZADO",       id: "kaba_cabito_gran",  tipos: ["Unidad","Caja"] },
    { nombre: "PAPAS HORNEABLES MC CAIN 700G", id: "kaba_papas_mccain", tipos: ["Bolsa"] }
  ],
  citric: [
    { nombre: "CITRIC 250ML", id: "citric_250", tipos: ["Unidad","Pack"] },
    { nombre: "CITRIC 500ML", id: "citric_500", tipos: ["Unidad","Pack"] }
  ],
  sm_alimentos: [
    { nombre: "MAYONESA 460G (POMO)",       id: "sm_mayo_460",     tipos: ["Unidad"] },
    { nombre: "CHEDDAR 480G (POMO)",        id: "sm_cheddar_480",  tipos: ["Unidad"] },
    { nombre: "KETCHUP 500G (POMO)",        id: "sm_ketchup_500",  tipos: ["Unidad"] },
    { nombre: "MOSTAZA 500G (POMO)",        id: "sm_mostaza_500",  tipos: ["Unidad"] },
    { nombre: "MAYONESA EN SOBRE (UNIDAD)", id: "sm_mayo_sobre",   tipos: ["Unidad","Pack"] },
    { nombre: "PAPAS PAY",                  id: "sm_papas_pay",    tipos: ["Unidad","Pack"] },
    { nombre: "PAN DE PEBETE (x6)",         id: "sm_pan_pebete",   tipos: ["Pack"] },
    { nombre: "PAN DE HAMBURGUESA (x8)",    id: "sm_pan_hamb",     tipos: ["Pack"] },
    { nombre: "HAMBURGUESA (x8)",           id: "sm_hamb",         tipos: ["Pack"] },
    { nombre: "SALCHICHAS LARGAS (x12)",    id: "sm_salchi_largas",tipos: ["Pack"] },
    { nombre: "PAN DE PANCHO LARGO (x12)",  id: "sm_pan_pancho",   tipos: ["Pack"] }
  ],
  la_alimenticia: [
    { nombre: "SOBRE QUESO RALLADO LA QUESERA", id: "ali_queso_ral", tipos: ["Unidad","Pack"] },
    { nombre: "SOBRE ACEITE",                   id: "ali_aceite",    tipos: ["Unidad","Pack"] },
    { nombre: "SOBRE VINAGRE",                  id: "ali_vinagre",   tipos: ["Unidad","Pack"] },
    { nombre: "SOBRE JUGO DE LIMÓN",            id: "ali_limon",     tipos: ["Unidad","Pack"] },
    { nombre: "SOBRE SAL FINA",                 id: "ali_sal",       tipos: ["Unidad","Pack"] }
  ],
  milkaut: [
    { nombre: "CREMA MILKAUT 330G",       id: "milk_crema_330",  tipos: ["Unidad"] },
    { nombre: "YOGURT 120G",              id: "milk_yogurt_120", tipos: ["Unidad","Pack"] },
    { nombre: "LECHE 1 LITRO DESCREMADA", id: "milk_leche_1l",   tipos: ["Unidad","Pack"] }
  ],
  distrimax: [
    { nombre: "BIDÓN LAVANDINA 5LTS",        id: "dmax_lavandina",  tipos: ["Unidad"] },
    { nombre: "BIDÓN DESODORANTE DE PISO 5LTS",id: "dmax_desod_piso",tipos: ["Unidad"] },
    { nombre: "BIDÓN DETERGENTE 5LTS",       id: "dmax_detergente", tipos: ["Unidad"] },
    { nombre: "TRAPO AMARILLO",              id: "dmax_trapo",      tipos: ["Unidad"] },
    { nombre: "ESPONJA DE FIBRA",            id: "dmax_esponja",    tipos: ["Unidad"] }
  ],
  fiambreria: [
    { nombre: "SALAME MILÁN 190G FETEADO",    id: "fiam_salame",     tipos: ["Unidad"] },
    { nombre: "JAMÓN COCIDO PIERES FETEADO",  id: "fiam_jamon",      tipos: ["Unidad"] },
    { nombre: "QUESO TYBO MELINCUE FETEADO",  id: "fiam_queso_tybo", tipos: ["Unidad"] },
    { nombre: "CILINDRO MUZARELLA TONUTTI",   id: "fiam_muzarella",  tipos: ["Unidad","KG"] }
  ],
  avimas: [
    { nombre: "SUPREMA DESHUESADA (KG)",   id: "avi_suprema",     tipos: ["KG"] },
    { nombre: "ESPINACA EN BOLSA GREENS",  id: "avi_espinaca",    tipos: ["Bolsa"] },
    { nombre: "HUEVO BLANCO",              id: "avi_huevo",       tipos: ["Docena","Mazo"] },
    { nombre: "HARINA PARA PIZZA PUREZA",  id: "avi_harina_pizza",tipos: ["KG","Bolsa"] }
  ],
  ailutap: [
    { nombre: "TAPA DE EMPANADA 13CM (DOCENA)",         id: "ail_tapa_emp",      tipos: ["Docena"] },
    { nombre: "TAPA DE TARTA PASCUALINA 30CM (6 JUEGOS)",id: "ail_tapa_tarta_30",tipos: ["Pack"] },
    { nombre: "TAPA DE TARTA PASCUALINA 19CM (6 JUEGOS)",id: "ail_tapa_tarta_19",tipos: ["Pack"] }
  ],
  dietetica: [
    { nombre: "DIETÉTICA MIX FRUTOS SECOS 40G",  id: "diet_frutos_secos", tipos: ["Unidad","Pack"] },
    { nombre: "DIETÉTICA ARITOS MULTICOLOR 40G", id: "diet_aritos",       tipos: ["Unidad","Pack"] }
  ],
  marilu: [
    { nombre: "COLITA DE CUADRIL (KG)",    id: "marl_cuadril",     tipos: ["KG"] },
    { nombre: "MILANESA CUADRADA (KG)",    id: "marl_milanesa",    tipos: ["KG"] },
    { nombre: "CARNE PICADA ESPECIAL (KG)",id: "marl_carne_picada",tipos: ["KG"] },
    { nombre: "MILANESA DE CERDO",         id: "marl_cerdo",       tipos: ["KG"] },
    { nombre: "BONDIOLA FRESCA",           id: "marl_bondiola",    tipos: ["KG"] }
  ],
  grado_cero: [
    { nombre: "FILETE DE MERLUZA A LA ROMANA", id: "gz_filete_merl",  tipos: ["KG","Unidad"] },
    { nombre: "MILANESA DE SOJA CON JQ",       id: "gz_soja_jq",      tipos: ["KG","Unidad"] },
    { nombre: "NUGGETS (COD.8003) POR KG",     id: "gz_nuggets",      tipos: ["KG"] },
    { nombre: "CHOCLO EN BOLSA MC CAIN",       id: "gz_choclo_mccain",tipos: ["Bolsa"] }
  ],
  reparto_gm: [
    { nombre: "ETIQUETAS ROLLO 64x32",          id: "rgm_etiquetas",     tipos: ["Rollo"] },
    { nombre: "BROWNIE",                        id: "rgm_brownie",       tipos: ["Unidad","Docena"] },
    { nombre: "EMPANADA DE CARNE",              id: "rgm_emp_carne",     tipos: ["Unidad","Docena"] },
    { nombre: "EMPANADA DE POLLO",              id: "rgm_emp_pollo",     tipos: ["Unidad","Docena"] },
    { nombre: "EMPANADA DE JAMÓN Y QUESO",      id: "rgm_emp_jyq",       tipos: ["Unidad","Docena"] },
    { nombre: "PIZZA DE MUZARELLA",             id: "rgm_pizza_muz",     tipos: ["Unidad"] },
    { nombre: "TARTA DE ATÚN",                  id: "rgm_tarta_atun",    tipos: ["Unidad","Porción"] },
    { nombre: "TARTA DE CALABAZA",              id: "rgm_tarta_calab",   tipos: ["Unidad","Porción"] },
    { nombre: "TARTA DE ESPINACA",              id: "rgm_tarta_espin",   tipos: ["Unidad","Porción"] },
    { nombre: "ENSALADA DE FRUTAS",             id: "rgm_ens_frutas",    tipos: ["Unidad"] },
    { nombre: "PORCIÓN DE NUGGETS",             id: "rgm_nugg_porc",     tipos: ["Porción"] },
    { nombre: "PAN FIGAZA",                     id: "rgm_pan_figaza",    tipos: ["Unidad"] },
    { nombre: "ENSALADA GM",                    id: "rgm_ensalada_gm",   tipos: ["Unidad"] },
    { nombre: "TUPPER DE MILANESA",             id: "rgm_tupp_milanesa", tipos: ["Medio","1","2"] },
    { nombre: "GUISO DE LENTEJAS",              id: "rgm_guiso_lent",    tipos: ["KG","Porción"] },
    { nombre: "FILETE MERLUZA REBOZADO",        id: "rgm_filete_reboz",  tipos: ["Unidad","KG"] },
    { nombre: "TUPPER DE SUPREMA",              id: "rgm_tupp_suprema",  tipos: ["Medio","1","2"] },
    { nombre: "PECHUGA GRILLADA",               id: "rgm_pechuga_grill", tipos: ["Unidad","KG"] },
    { nombre: "COLITA CUADRIL AL HORNO",        id: "rgm_cuadril_horno", tipos: ["KG"] },
    { nombre: "ENSALADA COMPLETA CON ATÚN",     id: "rgm_ens_atun",      tipos: ["Unidad"] },
    { nombre: "ENSALADA COMPLETA CON POLLO",    id: "rgm_ens_pollo",     tipos: ["Unidad"] },
    { nombre: "ENSALADA COMPLETA CON HUEVO",    id: "rgm_ens_huevo",     tipos: ["Unidad"] },
    { nombre: "ENSALADA BÁSICA GM",             id: "rgm_ens_basica",    tipos: ["Unidad"] },
    { nombre: "TORTILLA DE PAPA",               id: "rgm_tortilla_papa", tipos: ["Unidad","Porción"] },
    { nombre: "TUPPER DE CERDO",                id: "rgm_tupp_cerdo",    tipos: ["Medio","1","2"] },
    { nombre: "BONDOLA AL HORNO",               id: "rgm_bondola_horno", tipos: ["KG"] },
    { nombre: "VIANDA PERSONAL",                id: "rgm_vianda",        tipos: ["Unidad"] },
    { nombre: "KG ARROZ CON SALSA",             id: "rgm_arroz_salsa",   tipos: ["KG"] },
    { nombre: "KG PURÉ DE CALABAZA",            id: "rgm_pure_calab",    tipos: ["KG"] },
    { nombre: "KG PURÉ DE PAPA",                id: "rgm_pure_papa",     tipos: ["KG"] },
    { nombre: "SALSA BLANCA (PORCIÓN)",         id: "rgm_salsa_blanca",  tipos: ["Porción"] }
  ],
  makro: [
    { nombre: "YERBA PLAYADITO 500G",              id: "mak_yerba",     tipos: ["Unidad"] },
    { nombre: "AZÚCAR CHANGO 1KG",                 id: "mak_azucar",    tipos: ["Unidad"] },
    { nombre: "HARINA 000 MORIXE",                 id: "mak_harina",    tipos: ["Unidad"] },
    { nombre: "ATÚN EN ACEITE LATA 120G ESCURRIDO",id: "mak_atun",      tipos: ["Unidad","Pack"] },
    { nombre: "TOMATE TRITURADO M&K 970G",         id: "mak_tomate",    tipos: ["Unidad"] },
    { nombre: "ARROZ PARBOLIZADO 1KG",             id: "mak_arroz",     tipos: ["Unidad"] },
    { nombre: "QUESO RALLADO DIA 150G",            id: "mak_q_rallado", tipos: ["Unidad"] },
    { nombre: "ACEITE LEGÍTIMO 1500ML",            id: "mak_aceite",    tipos: ["Unidad"] },
    { nombre: "MANTECA 200G",                      id: "mak_manteca",   tipos: ["Unidad"] },
    { nombre: "CALDO MAGGI (CAJITA 12u)",          id: "mak_caldo",     tipos: ["Caja"] },
    { nombre: "DURAZNO EN CUBOS LATA 820G",        id: "mak_durazno",   tipos: ["Unidad"] },
    { nombre: "ORÉGANO 50G",                       id: "mak_oregano",   tipos: ["Unidad"] },
    { nombre: "ROCÍO VEGETAL FRITOLIM 120CC",      id: "mak_rocio_veg", tipos: ["Unidad"] },
    { nombre: "LENTEJAS 400G",                     id: "mak_lentejas",  tipos: ["Unidad"] }
  ],
  verduleria: [
    { nombre: "PAPA NEGRA (KG)",          id: "verd_papa",         tipos: ["KG"] },
    { nombre: "CALABAZA (KG)",            id: "verd_calabaza",     tipos: ["KG"] },
    { nombre: "CEBOLLA (KG)",             id: "verd_cebolla",      tipos: ["KG"] },
    { nombre: "ZANAHORIA (KG)",           id: "verd_zanahoria",    tipos: ["KG"] },
    { nombre: "TOMATE REDONDO (KG)",      id: "verd_tomate",       tipos: ["KG"] },
    { nombre: "LECHUGA CAPUCHINA (KG)",   id: "verd_lechuga",      tipos: ["KG"] },
    { nombre: "NARANJA (KG)",             id: "verd_naranja",      tipos: ["KG"] },
    { nombre: "UVA VERDE SIN SEMILLAS (KG)",id: "verd_uva",        tipos: ["KG"] },
    { nombre: "MANZANA ROJA (KG)",        id: "verd_manzana",      tipos: ["KG"] },
    { nombre: "MORRÓN (KG)",              id: "verd_morron",       tipos: ["KG"] },
    { nombre: "CEBOLLA VERDEO (KG)",      id: "verd_cebolla_verd", tipos: ["KG"] }
  ],
  todo_dulce: [
  { nombre: "AGREGAR MANUALMENTE", id: "td_manual", tipos: ["Unidad"] }
]
};
// Catálogo en uso: viene de Supabase (tabla productos). Si no está disponible, se usa el de respaldo.
let productosPorProveedor = PRODUCTOS_RESPALDO;


// ─────────────────────────────────────────
// 2. AGENDA
// ─────────────────────────────────────────

const agendasEscolares = {
  defensa: {
    sin_dia:   ["DEPÓSITO GM-PAPELERA","OSVALDO","DISTRIMAX(LIMPIEZA)","ALIMENTICIA(SOBRES)","AVIMAS","MARILÚ","DIETÉTICA"],
    lunes:     ["SM ALIMENTOS","DISTRIZORZ","KABA CONGELADOS","MAKRO","FIAMBRERÍA"],
    martes:    ["AILUTAP","OSVALDO"],
    miercoles: ["DISTRIZORZ","ARCOR CHOCOLATE","COCA COLA","MILKAUT","FIAMBRERÍA","VERDULERÍA","CITRIC","TODO DULCE"],
    jueves:    ["SM ALIMENTOS","KABA CONGELADOS","VERDULERÍA","RASTA ALFAJORES","OSVALDO","GRADO CERO","MILKAUT"],
    viernes:   ["MILKAUT","VERDULERÍA","COCA COLA","QUENTO","ARCOR GOLOSINAS"]
  },
  naval: {
    sin_dia:   ["DEPÓSITO GM-CAFETERÍA","DEPÓSITO GM-PAPELERA","OSVALDO"],
    lunes:     ["SM ALIMENTOS","RASTA ALFAJORES","KABA CONGELADOS"],
    martes:    ["REPARTO GM","ARCOR GOLOSINAS","OSVALDO"],
    miercoles: ["REPARTO GM","COCA COLA"],
    jueves:    ["SM ALIMENTOS","DISTRIZORZ","KABA CONGELADOS"],
    viernes:   ["REPARTO GM","PAPAS QUENTO","COCA COLA","ARCOR CHOCOLATE"]
  },
  lorca: {
    sin_dia:   ["DEPÓSITO GM-CAFETERÍA","DEPÓSITO GM-PAPELERA","OSVALDO"],
    lunes:     ["SM ALIMENTOS","OSVALDO","TODO DULCE"],
    martes:    ["CATERING GM","ARCOR GOLOSINAS","ARCOR CHOCOLATE"],
    miercoles: ["DISTRIZORZ","KABA CONGELADOS","COCA COLA","CITRIC"],
    jueves:    ["CATERING GM","SM ALIMENTOS","ARCOR GOLOSINAS","ARCOR CHOCOLATE","RASTA ALFAJORES","TODO DULCE"],
    viernes:   ["CATERING GM","KABA CONGELADOS","COCA COLA","QUENTO"]
  },
  grierson: {
    sin_dia:   ["DEPÓSITO GM-CAFETERÍA","DEPÓSITO GM-PAPELERA","OSVALDO"],
    lunes:     ["SM ALIMENTOS","CATERING GM"],
    martes:    ["OSVALDO","COCA COLA","TODO DULCE"],
    miercoles: ["DISTRIZORZ","RASTA ALFAJORES","KABA CONGELADOS","CATERING GM"],
    jueves:    ["SM ALIMENTOS","ARCOR GOLOSINAS","ARCOR CHOCOLATE"],
    viernes:   ["KABA CONGELADOS","COCA COLA","PAPAS QUENTO"]
  },
  tosco: {
    sin_dia:   ["DEPÓSITO GM-CAFETERÍA","DEPÓSITO GM-PAPELERA","OSVALDO"],
    lunes:     ["SM ALIMENTOS","OSVALDO","REPARTO GM"],
    martes:    ["ARCOR CHOCOLATES","TODO DULCE"],
    miercoles: ["DISTRIZORZ","KABA CONGELADOS","REPARTO GM"],
    jueves:    ["SM ALIMENTOS","RASTA ALFAJORES","ARCOR GOLOSINAS"],
    viernes:   ["REPARTO GM","COCA COLA","QUENTO"]
  }
};

// Mapa nombre agenda → id proveedor (todas las variantes posibles)
const agendaAProveedorId = {
  "SM ALIMENTOS":            "sm_alimentos",
  "DISTRIZORZ":              "distrizorz",
  "ARCOR GOLOSINAS":         "arcor_golosinas",
  "ARCOR CHOCOLATES":        "arcor_chocolates",
  "ARCOR CHOCOLATE":         "arcor_chocolates",
  "REPARTO GM":              "reparto_gm",
  "CATERING GM":             "reparto_gm",
  "OSVALDO":                 "osvaldo",
  "TODO DULCE":              "todo_dulce",
  "KABA CONGELADOS":         "kaba",
  "RASTA ALFAJORES":         "rasta",
  "PAPAS QUENTO":            "quento",
  "COCA COLA":               "coca_cola",
  "QUENTO":                  "quento",
  "CITRIC":                  "citric",
  "MAKRO":                   "makro",
  "MILKAUT":                 "milkaut",
  "VERDULERÍA":              "verduleria",
  "FIAMBRERÍA":              "fiambreria",
  "AVIMAS":                  "avimas",
  "AILUTAP":                 "ailutap",
  "DIETÉTICA":               "dietetica",
  "MARILÚ":                  "marilu",
  "GRADO CERO":              "grado_cero",
  "DISTRIMAX":               "distrimax",
  "DISTRIMAX(LIMPIEZA)":     "distrimax",
  "LA ALIMENTICIA":          "la_alimenticia",
  "ALIMENTICIA(SOBRES)":     "la_alimenticia",
  "DEPÓSITO GM-PAPELERA":    "deposito_papelera",
  "DEPÓSITO GM-CAFETERÍA":   "deposito_cafeteria",
  "DEPÓSITO GM (PAPELERA)":  "deposito_papelera",
  "DEPÓSITO GM (CAFETERÍA)": "deposito_cafeteria"
};

// ─────────────────────────────────────────
// 3. NAVEGACIÓN
// ─────────────────────────────────────────

function mostrarPantalla(id) {
  document.querySelectorAll(".pantalla").forEach(p => p.style.display = "none");
  document.getElementById(id).style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });
  actualizarBarraCarrito();
  // Dentro de un colegio: fondo suave y línea de color bajo el encabezado
  const dentroDeColegio = ["pantalla-proveedores", "pantalla-productos", "pantalla-carrito", "pantalla-agenda"].includes(id);
  document.body.classList.toggle("en-colegio", dentroDeColegio);
  const hd = document.querySelector(".header");
  if (hd && hd.offsetHeight) document.documentElement.style.setProperty("--alto-header", hd.offsetHeight + "px");
  const pestanas = { "pantalla-historial": "btn-historial", "pantalla-agenda": "btn-agenda", "pantalla-admin": "btn-admin" };
  ["btn-historial", "btn-agenda", "btn-admin"].forEach(b => {
    const el = document.getElementById(b);
    if (el) el.classList.toggle("activo", pestanas[id] === b);
  });
}

// Barra fija abajo: "Ver carrito (N productos)", visible solo dentro de un proveedor con productos
function actualizarBarraCarrito() {
  const barra = document.getElementById("barra-carrito");
  if (!barra) return;
  const items = pedidos[proveedorActual] || [];
  const n = items[0] === MARCA_NO_PIDO ? 0 : items.length;
  const enProductos = document.getElementById("pantalla-productos").style.display === "block";
  const visible = enProductos && n > 0;
  barra.style.display = visible ? "flex" : "none";
  document.body.classList.toggle("con-barra", visible);
  document.getElementById("barra-cant").innerText = n + (n === 1 ? " producto" : " productos");
}
function volverInicio()      { mostrarPantalla("pantalla-colegios"); }
function volverColegios()    { mostrarPantalla("pantalla-colegios"); }
function volverProductos()   { mostrarPantalla("pantalla-productos"); }

function volverProveedores() {
  const items = pedidos[proveedorActual] || [];
  const esNoPido = items[0] === MARCA_NO_PIDO;
  if (!esNoPido && items.length > 0) {
    if (!confirm("Tenés productos en el carrito. ¿Querés salir igual?")) return;
  }
  renderProveedores();
  mostrarPantalla("pantalla-proveedores");
}

// ─────────────────────────────────────────
// 4. RENDER COLEGIOS
// ─────────────────────────────────────────

function renderColegios() {
  let cont = document.getElementById("lista-colegios");
  cont.innerHTML = "";
  colegios.forEach(c => {
    let div = document.createElement("div");
    div.className = "colegio";
    div.style.borderLeft = `8px solid ${colorColegio(c.id)}`;
    div.innerHTML = `<h3>${c.nombre}</h3><button style="background:${colorColegio(c.id)};" onclick="seleccionarColegio('${c.id}')">Entrar</button>`;
    cont.appendChild(div);
  });
}

// Pinta con el color del colegio las barras "Volver" y muestra su nombre
function aplicarColorColegio(id) {
  const c = colegios.find(x => x.id === id);
  document.documentElement.style.setProperty("--color-colegio", colorColegio(id));
  document.documentElement.style.setProperty("--tinte-colegio", tinteColegio(colorColegio(id), 0.08));
  document.querySelectorAll(".tag-colegio").forEach(el => { el.innerText = c ? c.nombre : ""; });
}

async function seleccionarColegio(id) {
  colegioActual = id;
  aplicarColorColegio(id);
  document.getElementById("titulo-colegio").innerText = colegios.find(c => c.id === id).nombre;
  await Promise.all([traerPedidosDeHoy(), cargarProductos()]);
  aplicarEstadoColegio();
  renderProveedores();
  mostrarPantalla("pantalla-proveedores");
}

// ─────────────────────────────────────────
// 5. RENDER PROVEEDORES
// ─────────────────────────────────────────

const DIAS_CLAVE  = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
const DIAS_NOMBRE = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];

// Día de la semana (0 = domingo) en hora de Buenos Aires
function diaHoyIndice() {
  const en = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: "America/Argentina/Buenos_Aires" });
  return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].indexOf(en);
}

// Nombres de la agenda -> ids de proveedor (sin repetir)
function _idsDeAgenda(nombres) {
  const ids = [];
  (nombres || []).forEach(n => {
    const id = agendaAProveedorId[n];
    if (id && !ids.includes(id)) ids.push(id);
  });
  return ids;
}

// falta | encarrito | pedido | nopido
function _estadoVisual(id) {
  const items = pedidos[id] || [];
  if (items[0] === MARCA_NO_PIDO) return "nopido";
  if (items.length > 0) return "encarrito";
  if (proveedoresPedidos[id]) return "pedido";
  return "falta";
}

function _horaCorta(iso) {
  return iso
    ? new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" })
    : "";
}

function _nombreProveedor(id) {
  return proveedoresComunes.find(p => p.id === id)?.nombre || id.toUpperCase();
}

function _tarjetaProveedor(id, esDeHoy) {
  const estado = _estadoVisual(id);
  const nombre = escaparHTML(_nombreProveedor(id));
  const div = document.createElement("div");

  // Ya resuelto: tarjeta compacta, verde (pedido) o roja (no pido)
  if (estado === "pedido" || estado === "nopido") {
    const fila  = pedidosHoy.find(r => r.colegio_id === colegioActual && r.proveedor_id === id);
    const quien = fila && fila.usuario_email
      ? `👤 ${escaparHTML(fila.usuario_email)}${fila.actualizado_en ? " · " + _horaCorta(fila.actualizado_en) : ""}`
      : "";
    const esNo = estado === "nopido";
    div.className = "proveedor proveedor-listo " + (esNo ? "nopido" : "ok");
    div.innerHTML = `
      <div class="prov-fila">
        <h3>${esNo ? "🚫" : "✅"} ${nombre}</h3>
        <span class="badge-estado ${esNo ? "badge-nopido" : "badge-pedido"}">${esNo ? "NO PIDO" : "Pedido"}</span>
      </div>
      ${quien ? `<div class="prov-quien">${quien}</div>` : ""}
      <button class="btn-chico" onclick="seleccionarProveedor('${id}')">Ver</button>`;
    return div;
  }

  // Pendiente (falta pedir, o con productos en el carrito sin enviar)
  const enCarrito = estado === "encarrito";
  const cant = (pedidos[id] || []).length;
  let badge = "";
  if (enCarrito)    badge = `<span class="badge-estado badge-falta">En carrito (${cant})</span>`;
  else if (esDeHoy) badge = `<span class="badge-estado badge-falta">Falta pedir</span>`;

  div.className = "proveedor" + (esDeHoy ? " proveedor-hoy" : "");
  div.innerHTML = `
    <div class="prov-fila">
      <h3>${nombre}</h3>
      ${badge}
    </div>
    <button class="btn-entrar" onclick="seleccionarProveedor('${id}')">${enCarrito ? "Seguir pedido" : "Entrar"}</button>`;
  return div;
}

function _tituloGrupo(cont, texto) {
  const t = document.createElement("div");
  t.className = "grupo-titulo";
  t.innerText = texto;
  cont.appendChild(t);
}

function _grupoPlegable(cont, titulo, ids, abierto) {
  if (!ids.length) return;
  const det = document.createElement("details");
  det.className = "grupo";
  if (abierto) det.open = true;
  det.innerHTML = `<summary>${titulo} (${ids.length})</summary>`;
  const caja = document.createElement("div");
  caja.className = "contenido";
  ids.forEach(id => caja.appendChild(_tarjetaProveedor(id, false)));
  det.appendChild(caja);
  cont.appendChild(det);
}

function renderProveedores() {
  const cont = document.getElementById("lista-proveedores");
  cont.innerHTML = "";

  const idx     = diaHoyIndice();
  const agenda  = agendasEscolares[colegioActual] || {};
  const todos   = proveedoresPorColegio[colegioActual].map(p => p.id);

  const hoyIds    = _idsDeAgenda(agenda[DIAS_CLAVE[idx]]).filter(id => todos.includes(id));
  const sinDiaIds = _idsDeAgenda(agenda.sin_dia).filter(id => todos.includes(id) && !hoyIds.includes(id));
  const otrosIds  = todos.filter(id => !hoyIds.includes(id) && !sinDiaIds.includes(id));

  const esResuelto = id => ["pedido", "nopido"].includes(_estadoVisual(id));

  // Resumen del día
  const resumen = document.createElement("div");
  resumen.className = "hoy-resumen";
  if (hoyIds.length === 0) {
    resumen.innerHTML = `<div class="hoy-dia">${DIAS_NOMBRE[idx]} · hoy no hay pedidos programados</div>`;
  } else {
    const resueltos = hoyIds.filter(esResuelto).length;
    const completo  = resueltos === hoyIds.length;
    const pct = Math.round(resueltos / hoyIds.length * 100);
    resumen.innerHTML = `
      <div class="hoy-dia">${DIAS_NOMBRE[idx]} · hoy se pide</div>
      <div class="hoy-barra ${completo ? "completa" : ""}"><div style="width:${pct}%"></div></div>
      <div class="hoy-texto">${completo ? "✅ Todo resuelto por hoy" : `${resueltos} de ${hoyIds.length} pedidos listos`}</div>`;
  }
  cont.appendChild(resumen);

  // Lo de hoy: primero lo que falta, después lo ya resuelto
  const pendientes = hoyIds.filter(id => !esResuelto(id));
  const hechos     = hoyIds.filter(esResuelto);
  if (pendientes.length) {
    _tituloGrupo(cont, "Falta pedir");
    pendientes.forEach(id => cont.appendChild(_tarjetaProveedor(id, true)));
  }
  if (hechos.length) {
    _tituloGrupo(cont, "Ya resueltos");
    hechos.forEach(id => cont.appendChild(_tarjetaProveedor(id, true)));
  }

  // El resto, plegado (abierto solo si hoy no hay nada programado)
  _grupoPlegable(cont, "Sin día fijo", sinDiaIds, false);
  _grupoPlegable(cont, "Otros proveedores", otrosIds, hoyIds.length === 0);
}

function seleccionarProveedor(id) {
  proveedorActual = id;
  if (!pedidos[id]) pedidos[id] = [];
  const prov = proveedoresComunes.find(p => p.id === id);
  document.getElementById("titulo-proveedor").innerText = prov ? prov.nombre : id.toUpperCase();
  renderProductos();
  mostrarPantalla("pantalla-productos");
}

// ─────────────────────────────────────────
// 6. RENDER PRODUCTOS
// ─────────────────────────────────────────

function renderProductos() {
  let cont = document.getElementById("productos");
  cont.innerHTML = "";
  actualizarBarraCarrito();

  const itemsActuales = pedidos[proveedorActual] || [];
  const esNoPido = itemsActuales[0] === MARCA_NO_PIDO;
  const yaPidio  = !esNoPido && itemsActuales.length > 0;

  let banner = document.createElement("div");
  banner.className = "producto";

  if (esNoPido) {
    banner.style.borderLeft = "5px solid #e00";
    banner.innerHTML = `
      <h3 style="color:#e00;margin:0 0 6px;">🚫 NO PIDO</h3>
      <p style="font-size:0.85rem;color:#666;margin:0 0 10px;">
        Este proveedor ya fue marcado como <strong>NO PIDO</strong>.<br>
        Si querés hacer un pedido, cancelá la marca primero.
      </p>
      <button class="btn-gris" onclick="cancelarNoPido()">↩ Cancelar NO PIDO</button>`;
    cont.appendChild(banner);
    return;

  } else if (yaPidio) {
    banner.style.borderLeft = "5px solid #4CAF50";
    const resumen = itemsActuales.map(i => i.split(" - ")[0]).join(", ");
    banner.innerHTML = `
      <h3 style="color:#4CAF50;margin:0 0 4px;">✅ Ya pediste</h3>
      <p style="font-size:0.85rem;color:#666;margin:0 0 4px;">En carrito: <strong>${resumen}</strong></p>
      <p style="font-size:0.8rem;color:#999;margin:0 0 10px;">Podés seguir agregando o ir al carrito.</p>
      <button class="btn-verde" onclick="irCarrito()">🛒 Ver carrito</button>`;

  } else {
    banner.style.borderLeft = "5px solid #e00";
    banner.innerHTML = `
      <h3 style="color:#e00;margin:0 0 4px;">¿No pedís hoy?</h3>
      <p style="font-size:0.8rem;color:#666;margin:0 0 8px;">Marcá NO PIDO y quedará registrado.</p>
      <button class="btn-rojo" onclick="marcarNoPido()">🚫 NO PIDO</button>`;
  }

  cont.appendChild(banner);

  const lista = productosPorProveedor[proveedorActual] || [];
  const nombresEnPedido = itemsActuales.map(item => item.split(" - ")[0]);

  if (proveedorActual === "todo_dulce") {
  const div = document.createElement("div");
  div.className = "producto";
  div.innerHTML = `
    <h3>✏️ Producto personalizado</h3>
    <div class="contenedor-opciones" style="flex-direction:column;gap:8px;">
      <div class="opcion-input" style="width:100%;">
        <label>Nombre del producto</label>
        <input type="text" id="td_nombre" placeholder="Ej: Alfajor triple chocolate">
      </div>
      <div class="opcion-input" style="width:100%;">
        <label>Cantidad y unidad</label>
        <div style="display:flex;gap:8px;">
          <input type="number" id="td_cantidad" placeholder="0" style="width:30%;">
          <input type="text"   id="td_unidad"   placeholder="Ej: Caja, Unidad, Display" style="width:70%;">
        </div>
      </div>
    </div>
    <button onclick="agregarTodoDulce()">Agregar</button>
  `;
  cont.appendChild(div);
  return; // no renderiza la lista genérica
}

  lista.forEach(prod => {
    const yaAgregado = nombresEnPedido.includes(prod.nombre);
    const div = document.createElement("div");
    div.className = "producto" + (prod.sinStock ? " sin-stock" : "");
    div.dataset.producto = prod.id;

    // Sin stock: se ve, pero no se puede pedir
    if (prod.sinStock) {
      div.innerHTML = `<h3>${escaparHTML(prod.nombre)} <span class="badge-sinstock">SIN STOCK</span></h3>`;
      cont.appendChild(div);
      return;
    }

    let html = `<h3>${escaparHTML(prod.nombre)}</h3><div class="contenedor-opciones">`;
    prod.tipos.forEach(tipo => {
      html += `
        <div class="opcion-input">
          <label>${escaparHTML(tipo)}</label>
          <input type="number" placeholder="0" data-tipo="${escaparHTML(tipo)}">
        </div>`;
    });
    html += `</div>
      <button class="${yaAgregado ? 'pedido-listo' : ''}">${yaAgregado ? '✅ Agregado' : 'Agregar'}</button>`;
    div.innerHTML = html;

    div.querySelectorAll("input").forEach(inp => inp.addEventListener("input", () => bloquearOtros(div, inp)));
    div.querySelector("button").addEventListener("click", ev => agregarProducto(prod, div, ev));
    cont.appendChild(div);
  });
}
function agregarTodoDulce() {
  const nombre   = document.getElementById("td_nombre").value.trim();
  const cantidad = document.getElementById("td_cantidad").value.trim();
  const unidad   = document.getElementById("td_unidad").value.trim();

  if (!nombre)   return alert("Escribí el nombre del producto");
  if (!cantidad) return alert("Ingresá una cantidad");
  if (!unidad)   return alert("Ingresá la unidad (Ej: Caja, Display, Unidad)");

  const texto = `${nombre} - ${cantidad}x${unidad}`;
  pedidos[proveedorActual].push(texto);

  document.getElementById("td_nombre").value   = "";
  document.getElementById("td_cantidad").value = "";
  document.getElementById("td_unidad").value   = "";

  mostrarToast("Agregado ✅");
  actualizarBarraCarrito();
}

// ─────────────────────────────────────────
// 7. NO PIDO
// ─────────────────────────────────────────

async function marcarNoPido() {
  const colNom  = colegios.find(c => c.id === colegioActual).nombre.toUpperCase();
  const provNom = proveedoresComunes.find(p => p.id === proveedorActual)?.nombre || proveedorActual.toUpperCase();
  const texto   = `*${colNom}*\n\n*${provNom}*\n\nNO PIDO`;

  // Guardar en Supabase
  const guardado = await guardarPedido("no_pido", texto);
  if (!guardado) return mostrarToast("⚠️ No se pudo guardar. Probá de nuevo");

  pedidos[proveedorActual] = [MARCA_NO_PIDO];
  await traerPedidosDeHoy();

  // Copiar al portapapeles
  const done = () => {
    mostrarToast("NO PIDO copiado ✅ — proveedor bloqueado");
    renderProductos(); // muestra el banner bloqueado
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(done).catch(() => { _clipFallback(texto); done(); });
  } else { _clipFallback(texto); done(); }
}

function copiarPedido() {
  const items = pedidos[proveedorActual] || [];
  if (items.length === 0) return alert("El carrito está vacío");

  const colNom  = colegios.find(c => c.id === colegioActual).nombre.toUpperCase();
  const provNom = proveedoresComunes.find(p => p.id === proveedorActual)?.nombre || proveedorActual.toUpperCase();
  let texto = `*${colNom}*\n\n*${provNom}*\n\n`;

  if (items[0] === MARCA_NO_PIDO) {
    texto += `NO PIDO`;
  } else {
    items.forEach(item => {
      if (item.includes(" - ")) {
        const [nombre, detalle] = item.split(" - ");
        const [cant, tipo] = detalle.split("x");
        texto += `- ${cant} ${tipo.toUpperCase()} ${nombre}\n`;
      } else {
        texto += `- ${item}\n`;
      }
    });
  }

  // Intentá clipboard moderno, si no funciona usá el fallback
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto)
      .then(() => _pedidoCopiado(colNom, provNom, texto))
      .catch(() => _clipFallbackYCopiar(texto, colNom, provNom));
  } else {
    _clipFallbackYCopiar(texto, colNom, provNom);
  }
}

function _clipFallbackYCopiar(texto, colNom, provNom) {
  const ta = document.createElement("textarea");
  ta.value = texto;
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, 99999);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch(e) {}
  document.body.removeChild(ta);

  if (ok) {
    _pedidoCopiado(colNom, provNom, texto);
  } else {
    // Último recurso: mostrar el texto para copiar manualmente
    prompt("Copiá este texto manualmente (Ctrl+A, Ctrl+C):", texto);
  }
}

function _clipFallback(texto) {
  const ta = document.createElement("textarea");
  ta.value = texto;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, 99999);
  try { document.execCommand("copy"); } catch {}
  document.body.removeChild(ta);
}

// ─────────────────────────────────────────
// 8. CARRITO
// ─────────────────────────────────────────

function irCarrito() {
  if (!proveedorActual) return alert("Seleccioná un proveedor");
  renderCarrito();
  mostrarPantalla("pantalla-carrito");
}

function renderCarrito() {
  const lista = document.getElementById("carrito");
  lista.innerHTML = "";
  const items = pedidos[proveedorActual] || [];
  if (items.length === 0) {
    lista.innerHTML = "<li style='color:#999;'>El carrito está vacío.</li>";
    return;
  }
  items.forEach((item, index) => {
    const li = document.createElement("li");
    if (item === MARCA_NO_PIDO) {
      li.innerHTML = `<strong style="color:#e00;">🚫 NO PIDO</strong><button onclick="eliminar(${index})">🗑</button>`;
    } else {
      li.innerHTML = `<span>${item}</span><button onclick="eliminar(${index})">🗑</button>`;
    }
    lista.appendChild(li);
  });
}

function eliminar(index) {
  pedidos[proveedorActual].splice(index, 1);
  renderCarrito();
}

// ─────────────────────────────────────────
// 9. COPIAR PEDIDO
// ─────────────────────────────────────────

function copiarPedido() {
  const items = pedidos[proveedorActual] || [];
  if (items.length === 0) return alert("El carrito está vacío");

  const colNom  = colegios.find(c => c.id === colegioActual).nombre.toUpperCase();
  const provNom = proveedoresComunes.find(p => p.id === proveedorActual)?.nombre || proveedorActual.toUpperCase();
  let texto = `*${colNom}*\n\n*${provNom}*\n\n`;

  if (items[0] === MARCA_NO_PIDO) {
    texto += `NO PIDO`;
  } else {
    items.forEach(item => {
      if (item.includes(" - ")) {
        const [nombre, detalle] = item.split(" - ");
        const [cant, tipo] = detalle.split("x");
        texto += `- ${cant} ${tipo.toUpperCase()} ${nombre}\n`;
      } else {
        texto += `- ${item}\n`;
      }
    });
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(() => _pedidoCopiado(colNom, provNom, texto))
      .catch(() => _copiarFallback(texto, colNom, provNom));
  } else {
    _copiarFallback(texto, colNom, provNom);
  }
}

function _copiarFallback(texto, colNom, provNom) {
  const ta = document.createElement("textarea");
  ta.value = texto;
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, 99999);
  try { document.execCommand("copy"); _pedidoCopiado(colNom, provNom, texto); }
  catch { alert("No se pudo copiar. Seleccioná el texto manualmente."); }
  document.body.removeChild(ta);
}

async function _pedidoCopiado(colNom, provNom, texto) {
  const esNoPido = (pedidos[proveedorActual] || [])[0] === MARCA_NO_PIDO;
  const guardado = await guardarPedido(esNoPido ? "no_pido" : "pedido", texto);

  if (!guardado) {
    // Se copió al portapapeles pero NO se guardó: dejamos el carrito para reintentar
    mostrarToast("⚠️ Copiado, pero NO se guardó. Probá de nuevo");
    return;
  }

  proveedoresPedidos[proveedorActual] = true;
  if (!esNoPido) pedidos[proveedorActual] = [];
  await traerPedidosDeHoy();

  mostrarToast("✅ ¡Copiado y guardado! Pegalo en WhatsApp 📋");
  setTimeout(() => volverInicio(), 2000);
}

// ─────────────────────────────────────────
// 10. AGREGAR PRODUCTO
// ─────────────────────────────────────────

// Al cargar cantidad en una unidad, se vacían las otras unidades del mismo producto
function bloquearOtros(card, actual) {
  card.querySelectorAll("input").forEach(inp => {
    if (inp !== actual) inp.value = "";
  });
}

function agregarProducto(prod, card, event) {
  let texto = "";
  card.querySelectorAll("input").forEach(input => {
    if (Number(input.value) > 0) texto = `${prod.nombre} - ${input.value}x${input.dataset.tipo}`;
  });
  if (!texto) return alert("Ingresá una cantidad");
  pedidos[proveedorActual].push(texto);
  event.target.classList.add("pedido-listo");
  event.target.innerText = "✅ Agregado";
  card.querySelectorAll("input").forEach(i => i.value = "");
  mostrarToast("Agregado ✅");
  actualizarBarraCarrito();
}

// ─────────────────────────────────────────
// 11. HISTORIAL
// ─────────────────────────────────────────

async function verHistorial() {
  await traerPedidosDeHoy();
  const cont = document.getElementById("historial");
  cont.innerHTML = "";
  if (historial.length === 0) {
    cont.innerHTML = "<li style='color:#999;'>No hay pedidos realizados hoy.</li>";
  } else {
    historial.forEach(p => {
      const esNoPido = p.contenido.trim().endsWith("NO PIDO");
      const lineas = p.contenido.split("\n").filter(l => l.startsWith("- "));
      const itemsHTML = esNoPido
        ? `<span style="color:#e00;font-weight:bold;">🚫 NO PIDO</span>`
        : lineas.map(l => `<span style="display:block;font-size:0.85rem;color:#333;">${l}</span>`).join("");
      const li = document.createElement("li");
      li.style.cssText = "flex-direction:column;align-items:flex-start;gap:6px;";
      li.innerHTML = `
        <strong style="font-size:0.95rem;"><span class="punto-colegio" style="background:${colorColegio(p.colegioId)};"></span>${p.colegio} — ${p.proveedor}</strong>
        ${p.usuario ? `<span style="font-size:0.78rem;color:#777;">👤 ${escaparHTML(p.usuario)}${p.hora ? " · " + p.hora : ""}${p.modificado ? " (modificado)" : ""}</span>` : ""}
        <div style="padding:6px 10px;background:#f5f5f5;border-radius:6px;width:100%;">${itemsHTML}</div>`;
      cont.appendChild(li);
    });
  }
  mostrarPantalla("pantalla-historial");
}

// ─────────────────────────────────────────
// 12. AGENDA
// ─────────────────────────────────────────

function _itemAgenda(p, pid) {
  if (!pid) return `<li>${p}</li>`;
  const items = pedidos[pid] || [];
  const esNoPido = items[0] === MARCA_NO_PIDO;
  const tieneEnCarrito = !esNoPido && items.length > 0;
  const yaCopio = proveedoresPedidos[pid];
  const yaPidio = tieneEnCarrito || yaCopio;

  const bg    = esNoPido ? "background:#ffeaea;" : yaPidio ? "background:#eaffea;" : "";
  const icono = esNoPido ? "🚫 " : yaPidio ? "✅ " : "";
  return `<li style="cursor:pointer;${bg}" onclick="irDesdeAgenda('${pid}')">${icono}${p} →</li>`;
}

function verAgenda() {
  if (!colegioActual) return alert("Seleccioná un colegio primero");
  const cont       = document.getElementById("agenda");
  const agendaData = agendasEscolares[colegioActual];
  const diasSemana = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
  const diaHoy     = diasSemana[new Date().getDay()];

  let html = `<h3 style="text-align:center;">Agenda ${colegioActual.toUpperCase()}</h3>`;

  if (agendaData.sin_dia && agendaData.sin_dia.length > 0) {
    html += `
      <div class="sin-dia-sticky" onclick="toggleSinDia()">
        <div class="sin-dia-header">
          <span>SIN DÍA (Flexible)</span>
          <span id="icono-toggle" class="toggle-icon">➕</span>
        </div>
        <ul id="lista-sin-dia" class="sin-dia-lista">
          ${agendaData.sin_dia.map(p => _itemAgenda(p, agendaAProveedorId[p])).join('')}
        </ul>
      </div>`;
  }

  ["lunes","martes","miercoles","jueves","viernes"].forEach(dia => {
    const proveedores = agendaData[dia] || [];
    const esHoy = dia === diaHoy;
    html += `
      <div class="dia-agenda ${esHoy ? 'dia-actual' : 'dia-pasivo'}" id="dia-${dia}">
        <div class="titulo-dia">
          ${dia.toUpperCase()}
          ${esHoy ? '<span class="etiqueta-hoy">HOY</span>' : ''}
        </div>
        <ul>
          ${proveedores.length
            ? proveedores.map(p => _itemAgenda(p, agendaAProveedorId[p])).join('')
            : '<li style="color:#aaa;">Sin entregas</li>'}
        </ul>
      </div>`;
  });

  cont.innerHTML = html;
  mostrarPantalla("pantalla-agenda");
  setTimeout(() => {
    const el = document.getElementById(`dia-${diaHoy}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
}

function irDesdeAgenda(proveedorId) {
  const prov = proveedoresComunes.find(p => p.id === proveedorId);
  if (!prov) return alert("Proveedor no encontrado");
  if (!pedidos[proveedorId]) pedidos[proveedorId] = [];
  proveedorActual = proveedorId;
  document.getElementById("titulo-proveedor").innerText = prov.nombre;
  renderProductos();
  mostrarPantalla("pantalla-productos");
}

function toggleSinDia() {
  const lista = document.getElementById("lista-sin-dia");
  const icono = document.getElementById("icono-toggle");
  const abierto = lista.style.display === "block";
  lista.style.display = abierto ? "none" : "block";
  icono.innerText      = abierto ? "➕" : "➖";
}

// ─────────────────────────────────────────
// 13. TOAST
// ─────────────────────────────────────────

function mostrarToast(msg) {
  const t = document.getElementById("toast");
  t.innerText = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500); // ← de 1800 a 2500
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
arrancar();