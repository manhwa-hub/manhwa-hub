
(function () {
    "use strict";

    const SUPABASE_URL = "https://lvbtxofhumoxvhwiqend.supabase.co";
    const SUPABASE_KEY = "sb_publishable_nCUD6Tfgu_Wog7t2d6eMyQ_dOlWk-0k";

    window.manwhahubSupabase = null;
    window.manwhahubConnectionError = "";

    if (!window.supabase) {
        window.manwhahubConnectionError =
            "Library Supabase tidak berhasil dimuat.";
        console.error(window.manwhahubConnectionError);
        return;
    }

    if (
        SUPABASE_URL === "ISI_PROJECT_URL" ||
        SUPABASE_KEY === "ISI_PUBLISHABLE_KEY"
    ) {
        window.manwhahubConnectionError =
            "URL atau Publishable Key belum diisi.";
        console.error(window.manwhahubConnectionError);
        return;
    }

    try {
        window.manwhahubSupabase =
            window.supabase.createClient(
                SUPABASE_URL,
                SUPABASE_KEY
            );

        console.log("Supabase berhasil diinisialisasi.");
    } catch (error) {
        window.manwhahubConnectionError =
            "Kesalahan konfigurasi: " + error.message;
        console.error(error);
    }
})();
