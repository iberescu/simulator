# Ad Campaign Traffic — API Documentation

## Access & keys

| | |
|--|--|
| **Base URL** | `https://campaigns.leadmaker.ai` |
| **API key** | `<API_KEY>` (see your `.env` — not committed) |

- **Auth header (entry call):** `Authorization: Bearer <API_KEY>` (or `X-API-Key: …`).
- **Per-campaign token:** returned by the entry call as `token`; pass it as `?token=<token>` (or header `X-Site-Token`) to read status.

---

## Endpoints

### 1. Entry — `POST /api/campaigns`  (auth: API key)

Body: `url` (required, public http(s)), `timezone` (IANA, e.g. `Europe/London` — recommended), `customer` `{ name, email, company }`, `notes`.

**Request**
```bash
curl -s -X POST https://campaigns.leadmaker.ai/api/campaigns \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://shop.acme.com",
    "timezone": "America/Chicago",
    "customer": { "name": "Acme Inc", "email": "ops@acme.com", "company": "Acme" }
  }'
```

### 2. Status — `GET /api/campaigns/:id/status`  (auth: API key or `?token=`)

**Request**
```bash
curl -s "https://campaigns.leadmaker.ai/api/campaigns/<id>/status?token=<token>"
```
