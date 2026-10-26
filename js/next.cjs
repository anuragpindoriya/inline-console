// Next.js integration (next dev only, webpack or Turbopack):
//   // next.config.mjs
//   import withInlineConsole from 'inline-console/next';
//   export default withInlineConsole({ /* your config */ });
// Adds the console-rewriting loader to client, server and edge code. Browser logs go straight to
// WebStorm; server logs go through the same runtime as the Node preload, so no NODE_OPTIONS needed.
const LOADER = require.resolve('./webpack-loader.cjs');
const SOURCE = /\.(?:m?[jt]sx?|cjs|cts)$/;
const TURBO_GLOBS = ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.mts', '*.cts'];

// Next 15.3+ reads `turbopack`; 15.0–15.2 read `experimental.turbo`
function turbopackInExperimental(dir) {
  try {
    const version = require(require.resolve('next/package.json', { paths: [dir] })).version;
    const [major, minor] = version.split('.').map(Number);
    return major < 15 || (major === 15 && minor < 3);
  } catch {
    return false;
  }
}

function withLoaderRules(rules = {}) {
  const merged = { ...rules };
  for (const glob of TURBO_GLOBS) {
    if (merged[glob]) {
      // ponytail: an existing rule for the same glob wins; merging loader chains isn't worth the edge cases
      console.warn(`[inline-console] turbopack rule for ${glob} already set; console values from ${glob} files are skipped`);
    } else {
      merged[glob] = { loaders: [LOADER] };
    }
  }
  return merged;
}

// A config can be wrapped twice: in next.config and by the zero-config hook (maybe from another copy).
// The inner wrap does the work; the outer one sees its result and passes it through.
const wrapped = (globalThis.__inlineConsoleNextConfigs ??= new WeakSet());

// options.auto: added by the zero-config hook rather than written in next.config
module.exports = function withInlineConsole(nextConfig = {}, options = {}) {
  return async (phase, context) => {
    const config = typeof nextConfig === 'function' ? await nextConfig(phase, context) : await nextConfig;
    if (phase !== 'phase-development-server' || wrapped.has(config)) return config;
    require('./send.cjs').probe(options.auto ? 'next.js (auto)' : 'next.js');

    const userWebpack = config.webpack;
    const result = {
      ...config,
      webpack(webpackConfig, options) {
        webpackConfig.module.rules.push({
          test: SOURCE, exclude: /[\\/]node_modules[\\/]/, enforce: 'pre', use: [LOADER],
        });
        return typeof userWebpack === 'function' ? userWebpack(webpackConfig, options) : webpackConfig;
      },
    };
    if (turbopackInExperimental(process.cwd())) {
      const turbo = config.experimental?.turbo ?? {};
      result.experimental = { ...config.experimental, turbo: { ...turbo, rules: withLoaderRules(turbo.rules) } };
    } else {
      result.turbopack = { ...config.turbopack, rules: withLoaderRules(config.turbopack?.rules) };
    }
    wrapped.add(result);
    return result;
  };
};
