# BullMQ — TypeScript Message Queue Reference

BullMQ is a Node.js/Bun message queue library built on Redis. While it requires Redis (making it heavier than SQLite for local use), its API patterns are worth understanding for queue design.

## Installation

```bash
bun add bullmq ioredis
# Requires Redis running: brew install redis && brew services start redis
```

## Core Concepts

### Queue — Where jobs/messages are added

```typescript
import { Queue } from "bullmq";

const myQueue = new Queue("foo");

// Add a job
await myQueue.add("myJobName", { foo: "bar" });

// Add with options
await myQueue.add("myJobName", { data: "value" }, {
  delay: 5000,          // delay 5 seconds
  priority: 1,          // higher priority = processed first
  attempts: 3,          // retry 3 times on failure
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: true,
  removeOnFail: false,
});
```

### Worker — Processes jobs from the queue

```typescript
import { Worker } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis({ maxRetriesPerRequest: null });

const worker = new Worker(
  "foo",                    // queue name
  async (job) => {          // processor function
    console.log(job.id);    // unique job ID
    console.log(job.name);  // job name
    console.log(job.data);  // job payload

    // Return value is available to the producer
    return { result: "processed" };
  },
  { connection }
);

// Event handlers
worker.on("completed", (job) => {
  console.log(`${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.log(`${job.id} failed: ${err.message}`);
});
```

### QueueEvents — Centralized event monitoring

```typescript
import { QueueEvents } from "bullmq";

const queueEvents = new QueueEvents("foo");

queueEvents.on("waiting", ({ jobId }) => {
  console.log(`Job ${jobId} is waiting`);
});

queueEvents.on("active", ({ jobId, prev }) => {
  console.log(`Job ${jobId} is active (was ${prev})`);
});

queueEvents.on("completed", ({ jobId, returnvalue }) => {
  console.log(`Job ${jobId} completed: ${returnvalue}`);
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
  console.log(`Job ${jobId} failed: ${failedReason}`);
});

queueEvents.on("progress", ({ jobId, data }, timestamp) => {
  console.log(`Job ${jobId} progress: ${data} at ${timestamp}`);
});
```

---

## Message Queue Pattern (Inter-Process Communication)

BullMQ can be used for bidirectional messaging between servers/processes.

### Server A (Sends to B, Receives from B)

```typescript
const Queue = require("bull");

const sendQueue = new Queue("Server B");    // queue named for recipient
const receiveQueue = new Queue("Server A"); // queue named for self

receiveQueue.process(function (job, done) {
  console.log("Received message:", job.data.msg);
  done();
});

sendQueue.add({ msg: "Hello from A" });
```

### Server B (Sends to A, Receives from A)

```typescript
const sendQueue = new Queue("Server A");    // queue named for recipient
const receiveQueue = new Queue("Server B"); // queue named for self

receiveQueue.process(function (job, done) {
  console.log("Received message:", job.data.msg);
  done();
});

sendQueue.add({ msg: "Hello from B" });
```

### Key Points
- Queue names map to receiving servers/agents
- Data passed as job objects with a `data` property
- Asynchronous processing with callback/promise completion
- Persistent storage enables offline tolerance (receiver doesn't need to be running)
- Multiple workers can process from the same queue (round-robin)

---

## Advanced Features

### Job Progress

```typescript
const worker = new Worker("foo", async (job) => {
  for (let i = 0; i < 100; i++) {
    await job.updateProgress(i);
    // do work
  }
  return { done: true };
});
```

### Rate Limiting

```typescript
const worker = new Worker("foo", processor, {
  limiter: {
    max: 10,       // max 10 jobs
    duration: 1000, // per 1000ms
  },
});
```

### Flows (Parent-Child Jobs)

```typescript
import { FlowProducer } from "bullmq";

const flow = new FlowProducer();
await flow.add({
  name: "parent-job",
  queueName: "parent-queue",
  data: {},
  children: [
    { name: "child-1", queueName: "child-queue", data: { step: 1 } },
    { name: "child-2", queueName: "child-queue", data: { step: 2 } },
  ],
});
// Parent job won't process until all children complete
```

### Job Schedulers

```typescript
// Repeatable jobs
await myQueue.upsertJobScheduler("my-scheduler", {
  every: 60000, // every 60 seconds
}, {
  name: "scheduled-task",
  data: { type: "cleanup" },
});
```

---

## Comparison with SQLite Queue

| Feature | BullMQ | SQLite Queue |
|---------|--------|--------------|
| Dependencies | Redis + ioredis + bullmq | None (bun:sqlite built-in) |
| Persistence | Redis (RAM + disk) | SQLite file |
| Push vs Poll | Push (Redis pub/sub) | Poll |
| Latency | <10ms | ~100ms (poll interval) |
| Scaling | Horizontal (add workers) | Single machine |
| Features | Retries, rate limit, flows, scheduling | Basic FIFO |
| Complexity | Medium | Low |
| Best for | Production distributed systems | Local inter-process messaging |

---

## When to Use BullMQ

- You already have Redis running
- You need distributed processing across machines
- You need advanced features: retries, rate limiting, flows, scheduling
- You need push-based delivery (not polling)
- You have high throughput requirements (>1000 msgs/sec)

## When NOT to Use BullMQ

- Local-only inter-process messaging (SQLite is simpler)
- You want zero external dependencies
- Agents are few (<10) and co-located on same machine
- Latency of 100ms polling is acceptable

---

## Sources

- [BullMQ Documentation](https://docs.bullmq.io)
- [BullMQ Quick Start](https://docs.bullmq.io/readme-1)
- [BullMQ Message Queue Pattern](https://docs.bullmq.io/bull/patterns/message-queue)
- [BullMQ Workers](https://docs.bullmq.io/guide/workers)
- [BullMQ npm](https://www.npmjs.com/package/bullmq)
- [BullMQ GitHub](https://github.com/taskforcesh/bullmq)
