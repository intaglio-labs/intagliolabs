const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

function commandLineModel(argv) {
  let selected = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    let value = null;
    if (argument === '--model') {
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith('--')) {
        throw new TypeError('--model requires a model name');
      }
      value = String(next);
      index += 1;
    } else if (argument.startsWith('--model=')) {
      value = argument.slice('--model='.length);
      if (value.length === 0) throw new TypeError('--model requires a model name');
    }
    if (value === null) continue;
    if (selected !== null) throw new TypeError('--model may be specified only once');
    selected = value;
  }
  return selected;
}

export function selectEvalModel(argv = process.argv.slice(2), env = process.env) {
  const cli = commandLineModel(argv);
  const environment = String(env.PEOPLE_EVAL_LLAMA_MODEL ?? '').trim();
  const selected = String(cli ?? environment).trim();
  if (selected.length === 0) return null;
  if (!MODEL_NAME.test(selected)) throw new TypeError('invalid model name');
  return selected;
}
