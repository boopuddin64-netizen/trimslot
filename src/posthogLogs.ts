import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { config } from './config';

/**
 * Isolated PostHog log pipeline. Application loggers intentionally do not use
 * this provider, so only the purpose-written records below leave the service.
 */
const posthog = config.posthog;
const provider = posthog
  ? new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'trimslot-api' }),
    processors: [new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({
        url: `${posthog.host.replace(/\/$/, '')}/i/v1/logs`,
        headers: { Authorization: `Bearer ${posthog.key}` },
      }),
    })],
  })
  : undefined;
const posthogLogger = provider?.getLogger('trimslot.posthog.lifecycle');

type LogAttributes = Record<string, string | number | boolean>;

export const posthogLogs = {
  info: (body: string, attributes: LogAttributes = {}) => posthogLogger?.emit({ severityText: 'INFO', body, attributes }),
  error: (body: string, attributes: LogAttributes = {}) => posthogLogger?.emit({ severityText: 'ERROR', body, attributes }),
};

/** Flush only during long-running server shutdown; delivery never delays startup or request handling. */
export async function flushPostHogLogs() {
  if (!provider) return;
  const deadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref();
  });
  await Promise.race([provider.forceFlush().catch(() => undefined), deadline]);
}
