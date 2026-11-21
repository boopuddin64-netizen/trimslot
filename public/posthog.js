/* Browser-wide PostHog client. It is initialized once from the server's public runtime configuration. */
'use strict';
(function () {
  const methods = 'capture identify reset register unregister getFeatureFlag isFeatureEnabled onFeatureFlags'.split(' ');
  const posthog = window.posthog = window.posthog || [];
  methods.forEach((method) => {
    if (!posthog[method]) posthog[method] = function () { posthog.push([method].concat(Array.from(arguments))); };
  });

  fetch('/api/config', { credentials: 'same-origin' })
    .then((response) => response.ok ? response.json() : null)
    .then((config) => {
      const settings = config && config.posthog;
      if (!settings) {
        if (config && config.posthog_environment !== 'production') {
          const variable = !settings?.key ? 'POSTHOG_KEY' : 'POSTHOG_HOST';
          setTimeout(() => { throw new Error(`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`); }, 0);
        }
        return;
      }
      posthog._i = [[settings.key, {
        api_host: settings.host,
        defaults: '2026-08-30',
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false
        }
      }]];
      const script = document.createElement('script');
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = settings.host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
      document.head.appendChild(script);
    })
    .catch(() => {});
}());
