# Standart MCP serverlar

Platforma bilan birga keladigan MCP serverlar to'plami. `skills/` papkasi
bilan bir xil g'oya: bu yerdagi yozuvlar katalogga tushadi va foydalanuvchi
ularni MCP sahifasidan o'rnatadi.

**Hozircha bo'sh** — infratuzilma tayyor, mazmun keyin to'ldiriladi.
Qaysi serverlar "platforma tavsiyasi" bo'lishi mahsulot qarori.

## Qo'shish

Har server uchun bitta papka, ichida `server.json` — **rasmiy MCP publish
formati** (`registry.modelcontextprotocol.io` sxemasi bilan aynan bir xil).
Shu tufayli registry'dan olingan yozuvni to'g'ridan-to'g'ri ko'chirib
qo'yish mumkin.

```
mcp-serverlar/
  filesystem/
    server.json
```

stdio server misoli:

```json
{
  "name": "platforma/filesystem",
  "description": "Fayl tizimi bilan ishlash vositalari",
  "version": "1.0.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "@modelcontextprotocol/server-filesystem",
      "version": "1.0.0",
      "runtimeHint": "npx",
      "transport": { "type": "stdio" },
      "runtimeArguments": [{ "type": "positional", "value": "-y" }],
      "environmentVariables": [
        {
          "name": "ALLOWED_DIRS",
          "description": "Ruxsat etilgan papkalar (vergul bilan)",
          "isRequired": true
        }
      ]
    }
  ]
}
```

Masofaviy (http) server misoli:

```json
{
  "name": "platforma/masofaviy",
  "description": "Masofaviy MCP xizmati",
  "version": "1.0.0",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": [
        {
          "name": "Authorization",
          "description": "Kirish tokeni",
          "isRequired": true,
          "isSecret": true
        }
      ]
    }
  ]
}
```

## Muhim

- `isSecret: true` maydonlar bazaga **yozilmaydi** — ular alohida faylda
  (`~/.platforma/mcp-kredensiallar.json`, `chmod 600`).
- Fayl qo'shilgach server qayta ishga tushirilishi kerak: katalog har
  ishga tushishda skanerlanadi (`mcp-standart.ts`).
- Yozuvni o'zgartirsangiz `name` ni **o'zgartirmang**: sinxronlash nom
  bo'yicha ketadi va nom o'zgarsa mavjud o'rnatishlar (va kredensiallar)
  yo'qoladi.
