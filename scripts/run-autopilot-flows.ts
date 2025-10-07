/*
 End-to-end flow runner for Autopilot, based off the code in the autopilot-tester
 - Runs selected flows in parallel to allow us to test the various challenge tracks and types
 - Fails the process if any flow fails.
 - Uses Auth0 M2M credentials from env to write autopilot-tester secrets/m2m.json (if provided).

 Supported env vars:
 - AUTH0_CLIENT_ID / TC_M2M_CLIENT_ID
 - AUTH0_CLIENT_SECRET / TC_M2M_CLIENT_SECRET
 - AUTH0_AUDIENCE / M2M_AUDIENCE (default: https://m2m.topcoder-dev.com/)
 - AUTH0_TOKEN_URL / AUTH0_DOMAIN (default: https://topcoder-dev.auth0.com/oauth/token)
 - AUTOPILOT_E2E_FLOWS: comma list of flows (full,first2finish,topgear,topgearlate,design)
*/

/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type StepRequestLog = {
  id: string;
  method?: string;
  endpoint?: string;
  status?: number;
  message?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  timestamp?: string;
  durationMs?: number;
  outcome: 'success' | 'failure';
};

type StepEvent = {
  type: 'step';
  step: string;
  status: 'pending' | 'in-progress' | 'success' | 'failure';
  requests?: StepRequestLog[];
  failedRequests?: StepRequestLog[];
  timestamp: string;
};

type LogEvent = { level: 'info' | 'warn' | 'error'; message: string; data?: any; progress?: number };

// Lightweight logger compatible with autopilot-tester's RunnerLogger API
function createFlowLogger(prefix: string) {
  type Handler = (e: any) => void;
  const listeners: Record<string, Handler[]> = { log: [], step: [] };
  const emit = (event: 'log' | 'step', payload: any) => {
    for (const h of listeners[event]) {
      try { h(payload); } catch {}
    }
  };
  return {
    on(event: 'log' | 'step', handler: Handler) {
      (listeners[event] ||= []).push(handler);
    },
    off(event: 'log' | 'step', handler: Handler) {
      const arr = listeners[event];
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx !== -1) arr.splice(idx, 1);
    },
    log(level: LogEvent['level'], message: string, data?: any, progress?: number) {
      emit('log', { level, message, data, progress } satisfies LogEvent);
    },
    info(message: string, data?: any, progress?: number) { this.log('info', message, data, progress); },
    warn(message: string, data?: any, progress?: number) { this.log('warn', message, data, progress); },
    error(message: string, data?: any, progress?: number) { this.log('error', message, data, progress); },
    step(event: { step: string; status: StepEvent['status']; requests?: StepRequestLog[]; failedRequests?: StepRequestLog[]; timestamp?: string }) {
      const payload: StepEvent = {
        type: 'step',
        step: event.step,
        status: event.status,
        requests: event.requests,
        failedRequests: event.failedRequests,
        timestamp: event.timestamp ?? new Date().toISOString(),
      };
      emit('step', payload);
    },
    prefix,
  } as any; // typed as any to satisfy autopilot-tester signatures
}

function ensureM2MSecretsFromEnv(): void {
  const clientId = process.env.AUTH0_CLIENT_ID || process.env.TC_M2M_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET || process.env.TC_M2M_CLIENT_SECRET;
  const audience = process.env.AUTH0_AUDIENCE || process.env.M2M_AUDIENCE || 'https://m2m.topcoder-dev.com/';
  const tokenUrl = process.env.AUTH0_TOKEN_URL || (process.env.AUTH0_DOMAIN ? `https://${process.env.AUTH0_DOMAIN}/oauth/token` : 'https://topcoder-dev.auth0.com/oauth/token');

  // If both clientId and clientSecret are provided, write the secrets file expected by autopilot-tester
  if (clientId && clientSecret) {
    const targetDir = path.resolve(__dirname, '../../autopilot-tester/server/secrets');
    const targetFile = path.join(targetDir, 'm2m.json');
    fs.mkdirSync(targetDir, { recursive: true });
    const payload = { tokenUrl, audience, clientId, clientSecret };
    fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2));
    console.log(`[flows] Wrote M2M secrets to ${targetFile}`);
  }
}

function readAppConfig() {
  // Use autopilot-tester config loader so defaults are applied consistently
  const configFile = path.resolve(__dirname, '../../autopilot-tester/server/data/config.json');
  const modPath = path.resolve(__dirname, '../../autopilot-tester/server/src/types/config.ts');
  return import(modPath).then((m) => m.readAppConfigFile(configFile));
}

type FlowKey = 'full' | 'first2finish' | 'topgear' | 'topgearlate' | 'design';

async function runOneFlow(name: FlowKey) {
  const logger = createFlowLogger(name);
  const failures: { step?: string; details?: StepRequestLog[]; message?: string }[] = [];
  const errors: string[] = [];

  logger.on('log', (e: LogEvent) => {
    const head = e.level === 'error' ? '✖' : e.level === 'warn' ? '!' : '•';
    const progress = typeof e.progress === 'number' ? ` ${e.progress.toFixed(0)}%` : '';
    const dataNote = e.data ? ` ${JSON.stringify(e.data)}` : '';
    console.log(`[${name}] ${head} ${e.message}${progress}${dataNote}`);
    if (e.level === 'error') {
      errors.push(e.message);
    }
  });

  logger.on('step', (e: StepEvent) => {
    const statusIcon = e.status === 'success' ? '✓' : e.status === 'failure' ? '✖' : e.status === 'in-progress' ? '…' : '·';
    console.log(`[${name}] ${statusIcon} step=${e.step} status=${e.status}`);
    if (e.status === 'failure') {
      failures.push({ step: e.step, details: e.failedRequests });
    }
  });

  const config = await readAppConfig();

  const runFullPath = path.resolve(__dirname, '../../autopilot-tester/server/src/services/flowRunner.ts');
  const runF2FPath = path.resolve(__dirname, '../../autopilot-tester/server/src/services/first2finishRunner.ts');
  const runDesignPath = path.resolve(__dirname, '../../autopilot-tester/server/src/services/designRunner.ts');

  try {
    if (name === 'full') {
      const { runFlow } = await import(runFullPath);
      await runFlow(config.fullChallenge, 'full', undefined, logger);
    } else if (name === 'first2finish') {
      const { runFirst2FinishFlow } = await import(runF2FPath);
      await runFirst2FinishFlow(config.first2finish, 'full', undefined, logger);
    } else if (name === 'topgear') {
      const { runFirst2FinishFlow } = await import(runF2FPath);
      await runFirst2FinishFlow(config.topgear, 'full', undefined, logger, undefined, { submissionPhaseName: 'Topgear Submission' });
    } else if (name === 'topgearlate') {
      const { runFirst2FinishFlow } = await import(runF2FPath);
      await runFirst2FinishFlow(config.topgear, 'full', undefined, logger, undefined, { submissionPhaseName: 'Topgear Submission', lateSubmission: true, enablePostMortem: true });
    } else if (name === 'design') {
      const { runDesignFlow } = await import(runDesignPath);
      await runDesignFlow(config.designChallenge, 'full', undefined, logger);
    }
    const hadFailures = failures.length > 0 || errors.length > 0;
    return { name, ok: !hadFailures, failures, errors };
  } catch (err: any) {
    const msg = err?.message || String(err);
    errors.push(msg);
    return { name, ok: false, failures, errors };
  }
}

function parseFlowList(): FlowKey[] {
  const raw = process.env.AUTOPILOT_E2E_FLOWS || '';
  if (raw.trim()) {
    const list = raw.split(',').map((s) => s.trim().toLowerCase());
    const allowed: FlowKey[] = ['full', 'first2finish', 'topgear', 'topgearlate', 'design'];
    const picked = allowed.filter((f) => list.includes(f));
    if (picked.length) return picked;
  }
  return ['full', 'first2finish', 'topgear', 'topgearlate', 'design'];
}

async function main() {
  console.log('[flows] Preparing environment…');
  ensureM2MSecretsFromEnv();

  const flows = parseFlowList();
  console.log(`[flows] Running flows in parallel: ${flows.join(', ')}`);

  const results = await Promise.allSettled(flows.map((f) => runOneFlow(f)));

  // Summarize
  console.log('\n[flows] Summary');
  let anyFailed = false;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { name, ok, failures, errors } = r.value;
      console.log(`- ${name}: ${ok ? 'PASS' : 'FAIL'}`);
      if (!ok) {
        anyFailed = true;
        for (const err of errors) {
          console.log(`  • Error: ${err}`);
        }
        for (const f of failures) {
          if (!f) continue;
          console.log(`  • Step failed: ${f.step}`);
          for (const req of f.details || []) {
            const stat = req.status !== undefined ? ` ${req.status}` : '';
            const meth = req.method ? `${req.method} ` : '';
            console.log(`    - ${meth}${req.endpoint || ''}${stat} ${req.message || ''}`);
          }
        }
      }
    } else {
      anyFailed = true;
      console.log(`- (unknown): FAIL`);
      console.log(`  • ${String(r.reason)}`);
    }
  }

  if (anyFailed) {
    console.log('\n[flows] One or more flows failed');
    process.exitCode = 1;
  } else {
    console.log('\n[flows] All flows passed');
  }
}

// Run
void main();

