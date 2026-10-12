# BC.GS Telegram Bot

## Running

Required environment variables:

- `BOT_TOKEN=<telegram-bot-token>`
- `DATABASE_URL=<postgresql-connection-url>`

Optional environment variables:

- `ADMIN_CHAT_ID=<telegram-chat-id>`
- `DIRECT_URL=<direct-postgresql-connection-url>` (migrations only)
- `NOTIFICATIONS_ENABLED=true|false` (default `true`). When on, the bot checks `CaseNotificationOutbox` every 5 seconds and sends the case updates written by the BC.GS admin to users, in their saved language. `false`, `0`, `no` or `off` turns it off. Needs the `case_notification_outbox` migration from bc-gs; until it is applied, the bot logs a short database error about once a minute and keeps running.

Run locally with `npm run dev`. Build with `npm run build`, then start with `npm start`.

Build and run the Docker image:

```sh
docker build -t bcgs-telegram-bot .
docker run --env-file .env bcgs-telegram-bot
```

Only one instance may run at a time because the bot uses long polling and in-memory conversation state.
