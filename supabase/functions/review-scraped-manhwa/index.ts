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

    if (body.action === "list_chapters") {
      const pageSize = 1000;
      const allRows: unknown[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await admin.from("scraped_chapters")
          .select("id,manhwa_id,scraped_manhwa_id,title,chapter_number,source_id,source_url,source_updated_at,status,created_at,manhwa:manhwa_id(title),scraped_manhwa:scraped_manhwa_id(title)")
          .eq("status", "pending").order("created_at", { ascending: false })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        allRows.push(...(data || []));
        if (!data || data.length < pageSize) break;
        offset += pageSize;
      }
      return json({ success: true, data: allRows, total: allRows.length, returned: allRows.length, truncated: false }, 200, origin);
    }

    if (body.action === "review_chapter") {
      const id = Number(body.id);
      const status = body.status;
      if (!Number.isSafeInteger(id) || id <= 0) return json({ success: false, message: "ID chapter tidak valid." }, 400, origin);
      if (status !== "approved" && status !== "rejected") return json({ success: false, message: "Status review tidak valid." }, 400, origin);
      const { data: item, error: itemError } = await admin.from("scraped_chapters")
        .select("id,manhwa_id,title,chapter_number,source_url,status").eq("id", id).maybeSingle();
      if (itemError) throw itemError;
      if (!item) return json({ success: false, message: "Chapter antrean tidak ditemukan." }, 404, origin);
      if (item.status !== "pending") return json({ success: false, message: "Chapter ini sudah pernah diperiksa." }, 409, origin);
      if (status === "rejected") {
        const { error } = await admin.from("scraped_chapters").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return json({ success: true, message: "Chapter ditolak." }, 200, origin);
      }
      if (!item.manhwa_id) return json({ success: false, message: "Chapter belum terhubung ke Master Data. Setujui judul induknya terlebih dahulu." }, 409, origin);
      const { data: duplicate, error: duplicateError } = await admin.from("chapters")
        .select("id").eq("manhwa_id", item.manhwa_id).eq("chapter_number", item.chapter_number).limit(1).maybeSingle();
      if (duplicateError) throw duplicateError;
      let chapterId = duplicate?.id || null;
      if (!chapterId) {
        const { data: inserted, error: insertError } = await admin.from("chapters").insert({
          manhwa_id: item.manhwa_id, chapter_number: item.chapter_number,
          title: item.title || "", content_url: item.source_url || "",
        }).select("id").single();
        if (insertError) throw insertError;
        chapterId = inserted.id;
      }
      const { error: updateError } = await admin.from("scraped_chapters")
        .update({ status: "approved", manhwa_id: item.manhwa_id, updated_at: new Date().toISOString() }).eq("id", id);
      if (updateError) return json({ success: false, message: "Chapter sudah dibuat/ditemukan, tetapi status antrean gagal diperbarui. Periksa sebelum mengulang.", chapter_id: chapterId }, 500, origin);
      return json({ success: true, duplicate: !!duplicate, chapter_id: chapterId, message: duplicate ? "Chapter duplikat ditandai selesai tanpa membuat salinan." : "Chapter berhasil ditambahkan ke Master Data." }, 200, origin);
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
        const normalizeTitle = (value: string) => value.toLowerCase().normalize("NFKD")
          .replace(/[\\u0300-\\u036f]/g, "").replace(/^\\s*baca\\s+/i, "")
          .replace(/[^a-z0-9]+/g, " ").trim();
        const { data: existingRows, error: existingError } = await admin.from("manhwa").select("id,title,cover_url,synopsis");
        if (existingError) throw existingError;
        const existing = (existingRows || []).find((row: any) => normalizeTitle(row.title) === normalizeTitle(item.title));
        if (existing) {
          const patch: Record<string, unknown> = {};
          if (!existing.cover_url && item.cover_url) patch.cover_url = item.cover_url;
          if (!existing.synopsis && item.description) patch.synopsis = item.description;
          if (Object.keys(patch).length) {
            const { error: mergeError } = await admin.from("manhwa").update(patch).eq("id", existing.id);
            if (mergeError) throw mergeError;
          }
          const { error: linkError } = await admin.from("scraped_chapters")
            .update({ manhwa_id: existing.id, updated_at: new Date().toISOString() })
            .eq("scraped_manhwa_id", id).is("manhwa_id", null);
          if (linkError) throw linkError;
          const { error: statusError } = await admin.from("scraped_manhwa")
            .update({ status: "approved", updated_at: new Date().toISOString() }).eq("id", id);
          if (statusError) throw statusError;
          return json({ success: true, merged: true, manhwa_id: existing.id, message: "Judul sudah ada di Master Data. Data digabung tanpa membuat duplikat; chapter sudah ditautkan." }, 200, origin);
        }
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
        const { error: linkError } = await admin.from("scraped_chapters")
          .update({ manhwa_id: inserted.id, updated_at: new Date().toISOString() })
          .eq("scraped_manhwa_id", id).is("manhwa_id", null);
        if (linkError) throw linkError;
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
