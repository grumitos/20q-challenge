import { registerHooks } from "node:module";

// vinext puts `import "cloudflare:workers"` at the top of the built Worker (its tracing hook),
// and only workerd serves that module. Under Node it resolves to a Worker with no bindings.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "cloudflare:workers"
      ? { url: "data:text/javascript,export const env = {};", shortCircuit: true }
      : next(specifier, context),
});
