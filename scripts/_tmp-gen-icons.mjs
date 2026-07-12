import { ImageResponse } from "next/og.js";
import React from "react";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve("public");
fs.mkdirSync(OUT, { recursive: true });

// Ícone: quadrado com degradê verde (marca ZapInbox / NeoTech) + balão de chat
// branco centralizado. Padding generoso p/ ficar bom como maskable.
function icon(size, { rounded }) {
  const pad = Math.round(size * 0.22);
  const bubble = size - pad * 2;
  return React.createElement(
    "div",
    {
      style: {
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #12b76a 0%, #059669 55%, #047857 100%)",
        borderRadius: rounded ? Math.round(size * 0.22) : 0,
      },
    },
    React.createElement(
      "div",
      {
        style: {
          width: bubble,
          height: Math.round(bubble * 0.82),
          background: "#ffffff",
          borderRadius: Math.round(bubble * 0.28),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        },
      },
      // três "bolinhas" do balão (mensagem)
      React.createElement("div", { style: { display: "flex", gap: Math.round(bubble * 0.11) } },
        ...[0, 1, 2].map((i) =>
          React.createElement("div", {
            key: i,
            style: {
              width: Math.round(bubble * 0.13),
              height: Math.round(bubble * 0.13),
              borderRadius: "50%",
              background: "#059669",
            },
          }),
        ),
      ),
    ),
  );
}

async function writeIcon(name, size, opts) {
  const res = new ImageResponse(icon(size, opts), { width: size, height: size });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`  ✓ ${name} (${size}px, ${buf.length} bytes)`);
}

console.log("Gerando ícones em public/ ...");
await writeIcon("icon-192.png", 192, { rounded: false });
await writeIcon("icon-512.png", 512, { rounded: false });
await writeIcon("icon-maskable-512.png", 512, { rounded: false });
await writeIcon("apple-icon-180.png", 180, { rounded: true });
await writeIcon("favicon-48.png", 48, { rounded: true });
console.log("Pronto.");
