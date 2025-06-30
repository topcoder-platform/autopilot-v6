# Autopilot Scheduler Deployment Guide

This guide provides instructions to set up and run the Autopilot Scheduler with the new event-based phase transition system.

---

## 🚀 Prerequisites

- Node.js (v18+ recommended)
- Docker & Docker Compose
- Git
- Kafka (automatically started via Docker)
- A `.env` file with correct Kafka + service configs (see `.env.example`)

---

## 📦 Setup

1. **Clone the Repository**

```bash
git clone https://github.com/topcoder-platform/autopilot-v6.git
cd autopilot-v6
````

2. **Install Dependencies**

```bash
npm install
```

3. **Copy Environment Variables**

```bash
cp .env.example .env
```

> ⚠️ Ensure the Kafka broker address and topic names are set correctly in `.env`.

---

## 🐳 Start the Application

> This runs both Kafka and the app services in containers.

```bash
docker compose up --build -d
```

Wait for all services to come online.

---

## 🧪 Local Development (Optional)

To run the app directly with live code:

```bash
chmod +x ./start-local.sh
./start-local.sh
```

Make sure Kafka is running (e.g. via Docker), or configure the `.env` to point to a remote Kafka broker.

---

## 🔁 Recovery Behavior

On startup, the app will:

- Load active challenges and schedule future phase transitions
- Immediately handle overdue transitions
- Log all recovery events to the console

---

## 📡 Kafka Topics Used

- `autopilot.phase.transition` — publishes transition events
- `challenge.update` — listens for schedule change updates
- `autopilot.command` — handles manual scheduling commands

---

## ✅ Verifying It's Working

- Look for log output like:

```plaintext
[AutopilotService] Scheduled phase transition for challenge 101, phase 201 at 2025-06-20T12:00:00Z
```

- Confirm Kafka event:

```plaintext
[KAFKA-PRODUCER] Message produced to autopilot.phase.transition
```

---

## 📂 Project Structure Notes

| Folder          | Description                         |
| --------------- | ----------------------------------- |
| `src/autopilot` | Core scheduling logic               |
| `src/recovery`  | Startup logic to recover jobs       |
| `src/kafka`     | Kafka consumer and producer modules |

---

## 🧼 Stopping the System

```bash
docker compose down
```

---

If deploying to production, ensure:

- Kafka is running on a persistent broker
- The `.env` file contains production-ready configs
