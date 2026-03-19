require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mysql = require("mysql2");

// Inisialisasi Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Koneksi Database
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Center Numbers dari ENV
const centerTarikGp = process.env.CENTER_TARIK_GP;
const centerTarikMk = process.env.CENTER_TARIK_MK;

console.log("Bot Telegram Berjalan... Siap menerima perintah!");

// --- HELPER FUNCTIONS ---

// 1. Fungsi Format Data LDL (Gudang Pulsa)
function formatDataLdl(data) {
  if (!data) return [];
  const lines = data.trim().split("\n");
  return lines
    .map((line) => {
      const match = line.match(/#(\d+)\s+(.+?)\s+-\s+(\d+).+Rp\.\s([\d.]+)/);
      if (match) {
        const id = match[1];
        const name = match[2];
        const saldo = parseInt(match[4].replace(/\./g, ""), 10);
        if (saldo >= 500000) {
          const roundedAmount = Math.floor(saldo / 500000) * 500000;
          const message = `TRF.#${id}.${-roundedAmount}.2288`;

          // Double Encode
          let encodedMessage = encodeURIComponent(message).replace(
            /%23/g,
            "%2523",
          );
          const linkWA = `https://api.whatsapp.com/send?phone=${centerTarikGp}&text=${encodedMessage}`;

          return `${name} = Rp${saldo.toLocaleString(
            "id-ID",
          )} \n🚀 [KLIK TEMBAK](${linkWA})`;
        }
      }
      return null;
    })
    .filter(Boolean);
}

// 2. Fungsi Proses & Kirim List Downline (Makaryo)
function processAndSendDownlineList(
  chatId,
  uplineId,
  pinTrx = 1234,
  adjustmentFactor = 100000,
  centerNumber,
) {
  bot.sendChatAction(chatId, "typing");

  const query = `SELECT idreseller, NAMARESELLER, saldo FROM avr.masterreseller where idupline='${uplineId}'`;

  db.query(query, async function (err, rows) {
    if (err) {
      console.error(
        `[ERROR DB] Gagal ambil downline ${uplineId}:`,
        err.message,
      );
      bot.sendMessage(chatId, "⚠️ Maaf, terjadi gangguan koneksi database.");
      return;
    }

    // 1. Proses data menjadi array string
    const listItems = rows
      .map((row) => {
        const adjustedSaldo =
          Math.floor(row.saldo / adjustmentFactor) * adjustmentFactor;

        if (adjustedSaldo > 0) {
          const ldl = `${row.idreseller} - ${
            row.NAMARESELLER
          } = Rp${row.saldo.toLocaleString("id-ID")}`;
          const message = `T.${row.idreseller}.-${adjustedSaldo}.${pinTrx}`;
          let encodedMessage = encodeURIComponent(message).replace(
            /%23/g,
            "%2523",
          );
          const linkWA = `https://api.whatsapp.com/send?phone=${centerNumber}&text=${encodedMessage}`;

          return `${ldl}\n🚀 [KLIK TRANSFER](${linkWA})`;
        } else {
          return null;
        }
      })
      .filter((row) => row !== null);

    // 2. Logika Pengiriman "Smart Batching" (Split per 3000 chars)
    if (listItems.length > 0) {
      let messageBuffer = "";
      const MAX_LENGTH = 3000;

      for (const item of listItems) {
        if (messageBuffer.length + item.length + 4 > MAX_LENGTH) {
          await bot.sendMessage(chatId, messageBuffer, {
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          });
          messageBuffer = "";
        }
        messageBuffer += item + "\n\n";
      }

      if (messageBuffer.trim().length > 0) {
        await bot.sendMessage(chatId, messageBuffer, {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        });
      }
    } else {
      bot.sendMessage(
        chatId,
        "Zonk! Tidak ada downline dengan saldo mencukupi.",
      );
    }
  });
}

// --- LOGIKA UTAMA (LISTENER) ---

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id.toString();
  const firstName = msg.from.first_name || "";
  const lastName = msg.from.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  const username = msg.from.username
    ? `@${msg.from.username}`
    : "Tidak ada username";
  const text = msg.text || "";

  const waktuMasuk = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
  });
  console.log(
    `[${waktuMasuk}] 📩 PESAN BARU | Dari: ${fullName} (${senderId}) | Isi: "${text}"`,
  );

  // --- [BARU] LOGIKA START (REGISTRASI USER) ---
  if (text === "/start") {
    // Pesan 1: Info Profil
    const replyProfile =
      `Halo, *${fullName}* 👋\n\n` +
      `Berikut adalah data akun Telegram Anda:\n` +
      `🆔 ID: \`${senderId}\`\n` +
      `👤 Username: ${username}\n` +
      `📅 Waktu: ${waktuMasuk}`;

    await bot.sendMessage(chatId, replyProfile, { parse_mode: "Markdown" });

    // Pesan 2: Instruksi Lucu
    const instruction =
      "Copy dan kirim profil di atas ke Mas Dika gantennggzz yaak, Terimakasih..";
    await bot.sendMessage(chatId, instruction);

    return; // Stop proses di sini
  }
  // ---------------------------------------------

  // Logika Mmm (Cek Transaksi Pending)
  if (text.startsWith("Mmm") && senderId === process.env.ADMIN_ID) {
    bot.sendChatAction(chatId, "typing");

    db.query(
      `SELECT jam, jamterima, idreseller id, namareseller nama, kodeproduk KP, tujuan, namaterminal terminal, keterangan FROM transaksi WHERE statustransaksi NOT IN('1','2') LIMIT 50`,
      function (err, rows) {
        if (err) {
          console.error(`[ERROR DB] Gagal Cek Pending Mmm:`, err.message);
          bot.sendMessage(chatId, "⚠️ Gagal cek pending. Database bermasalah.");
          return;
        }

        const formattedPending = rows
          .map(
            (entry) =>
              `${entry.jam} - ${entry.jamterima} => ${entry.nama} (${entry.id}), ${entry.KP} ${entry.tujuan} => ${entry.terminal}\nKeterangan: ${entry.keterangan}`,
          )
          .join("\n\n");

        const sendPending =
          rows.length === 0
            ? "Transaksi Joss. Tidak ada Pending Boss kuhh.."
            : `Pending = ${rows.length}\n\n${formattedPending}`;

        bot.sendMessage(chatId, sendPending);
      },
    );

    // Logika Lll (Cek Stok/Sukses)
  } else if (text.startsWith("Lll") && senderId === process.env.ADMIN_ID) {
    bot.sendChatAction(chatId, "typing");

    db.query(
      `SELECT jam, namaterminal, stok FROM transaksi WHERE statustransaksi IN ('1') ORDER BY jam DESC LIMIT 50`,
      function (err, rows) {
        if (err) {
          console.error(`[ERROR DB] Gagal Cek Stok Lll:`, err.message);
          bot.sendMessage(chatId, "⚠️ Gagal cek stok. Database bermasalah.");
          return;
        }

        const seenTerminals = new Set();
        const formattedListTrx = rows
          .reverse()
          .map((entry) => {
            if (!seenTerminals.has(entry.namaterminal)) {
              seenTerminals.add(entry.namaterminal);
              return `${entry.jam} => ${entry.namaterminal} *Rp ${Number(
                entry.stok,
              ).toLocaleString("id-ID")}*`;
            }
            return null;
          })
          .filter((entry) => entry !== null)
          .sort()
          .join("\n\n");

        bot.sendMessage(chatId, formattedListTrx, { parse_mode: "Markdown" });
      },
    );

    // Logika Hhh
  } else if (text.startsWith("Hhh") && senderId === process.env.ID_TARIK) {
    bot.sendMessage(chatId, "Siaaap... Tunggu dilit iseh Loading...");
    processAndSendDownlineList(chatId, "mk0001", 2288, 500000, centerTarikMk);

    // Logika Ozzi
  } else if (
    text.startsWith("Ozzi") &&
    senderId === process.env.ID_TARIK_ARIFIN
  ) {
    bot.sendMessage(chatId, "Siaaap... Tunggu dilit iseh Loading...");
    processAndSendDownlineList(chatId, "mk0003", 2431, 50000, centerTarikMk);

    // Logika Jumar
  } else if (
    text.startsWith("Jumar") &&
    senderId === process.env.ID_TARIK_JUMAR
  ) {
    bot.sendMessage(chatId, "Siaaap... Tunggu dilit iseh Loading...");
    processAndSendDownlineList(chatId, "mk0007", 2312, 100000, centerTarikMk);

    // Logika Tarikjoss
  } else if (
    text.startsWith("Tarikjoss") &&
    senderId === process.env.ID_TARIK_MJ
  ) {
    bot.sendMessage(chatId, "Siaaap... Tunggu dilit iseh Loading...");
    processAndSendDownlineList(chatId, "mk0698", "0583", 50000, centerTarikMk);

    // Logika Tariksis
  } else if (
    text.startsWith("Tariksis") &&
    senderId === process.env.ID_TARIK_VICENZA
  ) {
    bot.sendMessage(
      chatId,
      "Semongkooo..... Wokee.. Tunggu dilit iseh Loading...",
    );
    processAndSendDownlineList(chatId, "mk0093", 1234, 50000, centerTarikMk);

    // Logika Tariksayang
  } else if (
    text.startsWith("Tariksayang") &&
    senderId === process.env.ID_TARIK_ANOM
  ) {
    bot.sendMessage(chatId, "Molorr masss.. Tunggu dilit iseh Loading...");
    processAndSendDownlineList(chatId, "mk0094", 1234, 50000, centerTarikMk);

    // Logika Downline anda (Parsing Pesan Forward)
  } else if (text.startsWith("Downline anda:")) {
    const formattedData = formatDataLdl(text);
    if (formattedData.length > 0) {
      bot.sendMessage(chatId, formattedData.join("\n\n"), {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } else {
      bot.sendMessage(chatId, "Wesss.. Beress... entek mas..");
    }
  }
});
