import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = new Set([
  "https://manhwa-hub.latifstar7.workers.dev",
  "https://manhwa-hub.github.io",
]);

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://manhwa-hub.latifstar7.workers.dev";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" },
  });
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ success: false, message: "Method not allowed." }, 405, origin);

  try {
    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return json({ success: false, message: "Authorization bearer token wajib disertakan." }, 401, origin);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return json({ success: false, message: "Sesi tidak valid atau sudah kedaluwarsa." }, 401, origin);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: profile, error: profileError } = await admin
      .from("profiles").select("role").eq("id", authData.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (profile?.role !== "admin") return json({ success: false, message: "Akses khusus administrator." }, 403, origin);

    const body = await req.json().catch(() => ({}));
    if (body.action === "list") {
      const { data, error } = await admin.from("scraped_manhwa")
        .select("id,title,description,cover_url,genres,status,source_id,created_at")
        .eq("status", "pending").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return json({ success: true, data: data || [], total: data?.length || 0 }, 200, origin);
    }

    if (body.action === "review") {
      const id = Number(body.id);
      const status = body.status;
      if (!Number.isSafeInteger(id) || id <= 0) return json({ success: false, message: "ID antrean tidak valid." }, 400, origin);
      if (status !== "approved" && status !== "rejected") return json({ success: false, message: "Status review tidak valid." }, 400, origin);

      const { data: item, error: itemError } = await admin.from("scraped_manhwa")
        .select("id,title,description,cover_url,genres,status,source_id")
        .eq("id", id).maybeSingle();
      if (itemError) throw itemError;
      if (!item) return json({ success: false, message: "Item antrean tidak ditemukan." }, 404, origin);
      if (item.status !== "pending") return json({ success: false, message: "Item ini sudah pernah diperiksa." }, 409, origin);

      if (status === "approved") {
        const baseSlug = slugify(item.title) || `manhwa-${item.id}`;
        const slug = `${baseSlug}-${item.id}`;
        const { data: inserted, error: insertError } = await admin.from("manhwa").insert({
          title: item.title,
          slug,
          synopsis: item.description || null,
          cover_url: item.cover_url || null,
          genres: item.genres || [],
          type: "manhwa",
          status: "ongoing",
        }).select("id").single();
        if (insertError) throw insertError;
        const { error: updateError } = await admin.from("scraped_manhwa")
          .update({ status: "approved", updated_at: new Date().toISOString() }).eq("id", id);
        if (updateError) {
          // Keep the newly created catalog record; report the partial outcome for safe manual reconciliation.
          return json({ success: false, message: "Manhwa sudah dibuat, tetapi status antrean gagal diperbarui. Jangan setujui ulang; periksa item ini di database.", manhwa_id: inserted.id }, 500, origin);
        }
        return json({ success: true, message: "Manhwa disetujui dan ditambahkan ke katalog.", manhwa_id: inserted.id }, 200, origin);
      }

      const { error: updateError } = await admin.from("scraped_manhwa")
        .update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", id);
      if (updateError) throw updateError;
      return json({ success: true, message: "Item scraper ditolak." }, 200, origin);
    }

    return json({ success: false, message: "Action tidak dikenal. Gunakan list atau review." }, 400, origin);
  } catch (error) {
    console.error("review-scraped-manhwa:", error);
    return json({ success: false, message: error instanceof Error ? error.message : "Internal server error." }, 500, origin);
  }
});
