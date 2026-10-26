// The user's Vite config (object, function or promise) -> the same config with inlineConsole() first.
// Errors from the user's own config still surface as usual; ours never do: on any failure of our
// own, the config is returned exactly as it was.
import inlineConsole from './vite.mjs';

export function wrapConfig(config) {
  return async (env) => {
    const resolved = await (typeof config === 'function' ? config(env) : config);
    try {
      if (!resolved || typeof resolved !== 'object') return resolved;
      // nested, not spread: Vite flattens plugin arrays and awaits plugin promises/lazy lists itself
      return { ...resolved, plugins: [inlineConsole({ auto: true }), resolved.plugins] };
    } catch {
      return resolved;
    }
  };
}
