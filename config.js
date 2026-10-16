// Configuración de Supabase (se edita una sola vez).
// La Publishable key es pública: está pensada para ir en el navegador.
// La Secret key y la contraseña de la base de datos NUNCA van acá.
const SUPABASE_URL = "https://fxxiuhxqlzgkylvdkpua.supabase.co";
const SUPABASE_KEY = "sb_publishable_hB38kKYOYDXejmsLH5zV1A_AjhWutWm"; // empieza con sb_publishable_
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);