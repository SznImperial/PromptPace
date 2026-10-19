export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-6 py-16">
      <p className="mb-3 text-xs font-medium tracking-[0.2em] text-teal-300 uppercase">
        Phase 1 scaffold
      </p>
      <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">PromptPace</h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-400">
        Local proxy for AI coding tools. Spend tracking, budgets and runaway-loop detection.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          ["mock-llm", "8788", "Canned Anthropic-shaped responses, streaming and usage."],
          ["proxy", "8787", "Pass-through to the upstream and SQLite request log."],
          ["dashboard", "3000", "This scaffold. Live data arrives in phase 2."],
        ].map(([name, port, detail]) => (
          <div
            key={name}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-sm text-zinc-200">{name}</span>
              <span className="font-mono text-xs text-teal-300">:{port}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">{detail}</p>
          </div>
        ))}
      </div>

      <p className="mt-10 font-mono text-xs text-zinc-500">
        proxy API: <span className="text-zinc-300">http://127.0.0.1:8787/health</span>
      </p>
    </main>
  );
}
