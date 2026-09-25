import { matchPattern, normalizeHost } from './policy.js';

export const KINDS = {
  model: 'Model API',
  account: 'Sign-in',
  telemetry: 'Telemetry',
  registry: 'Package registry',
  code: 'Code hosting',
};

// Who runs a host and what it is generally for. A label describes the
// endpoint, not what a particular tool sent to it. First match wins.
const KNOWN = [
  ['api.anthropic.com', 'model', 'Anthropic API'],
  ['statsig.anthropic.com', 'telemetry', 'Anthropic (Statsig)'],
  ['claude.ai', 'account', 'Claude.ai'],
  ['platform.claude.com', 'account', 'Claude Platform'],
  ['console.anthropic.com', 'account', 'Anthropic Console'],
  ['api.openai.com', 'model', 'OpenAI API'],
  ['auth.openai.com', 'account', 'OpenAI sign-in'],
  ['*.chatgpt.com', 'model', 'ChatGPT'],
  ['generativelanguage.googleapis.com', 'model', 'Gemini API'],
  ['cloudcode-pa.googleapis.com', 'model', 'Gemini Code Assist'],
  ['*.aiplatform.googleapis.com', 'model', 'Vertex AI'],
  ['accounts.google.com', 'account', 'Google sign-in'],
  ['oauth2.googleapis.com', 'account', 'Google sign-in'],
  ['bedrock-runtime.*.amazonaws.com', 'model', 'Amazon Bedrock'],
  ['*.openai.azure.com', 'model', 'Azure OpenAI'],
  ['*.services.ai.azure.com', 'model', 'Azure AI Foundry'],
  ['openrouter.ai', 'model', 'OpenRouter'],
  ['api.deepseek.com', 'model', 'DeepSeek API'],
  ['open.bigmodel.cn', 'model', 'Zhipu GLM API'],
  ['api.z.ai', 'model', 'Z.ai GLM API'],
  ['api.moonshot.cn', 'model', 'Moonshot (Kimi) API'],
  ['api.moonshot.ai', 'model', 'Moonshot (Kimi) API'],
  ['dashscope.aliyuncs.com', 'model', 'Alibaba DashScope'],
  ['dashscope-intl.aliyuncs.com', 'model', 'Alibaba DashScope'],
  ['api.mistral.ai', 'model', 'Mistral API'],
  ['api.groq.com', 'model', 'Groq API'],
  ['api.x.ai', 'model', 'xAI API'],
  ['api.together.xyz', 'model', 'Together AI'],
  ['api.fireworks.ai', 'model', 'Fireworks AI'],
  ['*.githubcopilot.com', 'model', 'GitHub Copilot'],
  ['*.cursor.sh', 'model', 'Cursor'],

  ['*.statsig.com', 'telemetry', 'Statsig'],
  ['*.statsigapi.net', 'telemetry', 'Statsig'],
  ['*.sentry.io', 'telemetry', 'Sentry'],
  ['*.datadoghq.com', 'telemetry', 'Datadog'],
  ['*.datadoghq.eu', 'telemetry', 'Datadog'],
  ['*.segment.io', 'telemetry', 'Segment'],
  ['*.segment.com', 'telemetry', 'Segment'],
  ['*.posthog.com', 'telemetry', 'PostHog'],
  ['*.mixpanel.com', 'telemetry', 'Mixpanel'],
  ['*.amplitude.com', 'telemetry', 'Amplitude'],
  ['*.honeycomb.io', 'telemetry', 'Honeycomb'],
  ['*.launchdarkly.com', 'telemetry', 'LaunchDarkly'],
  ['*.bugsnag.com', 'telemetry', 'Bugsnag'],
  ['*.rollbar.com', 'telemetry', 'Rollbar'],
  ['*.newrelic.com', 'telemetry', 'New Relic'],
  ['*.nr-data.net', 'telemetry', 'New Relic'],
  ['*.google-analytics.com', 'telemetry', 'Google Analytics'],

  ['registry.npmjs.org', 'registry', 'npm'],
  ['registry.yarnpkg.com', 'registry', 'Yarn'],
  ['registry.npmmirror.com', 'registry', 'npmmirror'],
  ['pypi.org', 'registry', 'PyPI'],
  ['files.pythonhosted.org', 'registry', 'PyPI files'],
  ['*.tuna.tsinghua.edu.cn', 'registry', 'TUNA mirror'],
  ['mirrors.aliyun.com', 'registry', 'Aliyun mirror'],
  ['*.crates.io', 'registry', 'crates.io'],
  ['proxy.golang.org', 'registry', 'Go module proxy'],
  ['sum.golang.org', 'registry', 'Go checksum DB'],
  ['*.rubygems.org', 'registry', 'RubyGems'],
  ['repo.maven.apache.org', 'registry', 'Maven Central'],
  ['repo1.maven.org', 'registry', 'Maven Central'],
  ['*.docker.io', 'registry', 'Docker Hub'],
  ['jsr.io', 'registry', 'JSR'],
  ['nodejs.org', 'registry', 'Node.js'],

  ['*.github.com', 'code', 'GitHub'],
  ['*.githubusercontent.com', 'code', 'GitHub content'],
  ['gitlab.com', 'code', 'GitLab'],
  ['bitbucket.org', 'code', 'Bitbucket'],
  ['gitee.com', 'code', 'Gitee'],
  ['codeberg.org', 'code', 'Codeberg'],
];

export function classify(host) {
  const normalized = normalizeHost(host);
  for (const [pattern, kind, label] of KNOWN) {
    if (matchPattern(normalized, pattern)) return { kind, label };
  }
  return { kind: null, label: null };
}
