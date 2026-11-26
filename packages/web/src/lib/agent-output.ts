type Fragment<Body extends 'text' | 'message'> = {
  at: string;
  kind?: string;
  agent?: string;
  nodeId?: string;
} & Record<Body, string>;

/** Preserve the token stream, including whitespace supplied by the model. */
export function compactOutput<Body extends 'text' | 'message', Item extends Fragment<Body>>(
  items: readonly Item[], body: Body,
): Item[] {
  const output: Item[] = [];
  for (const item of items) {
    const previous = output.at(-1);
    const sameSpeaker = previous && previous.agent === item.agent && previous.nodeId === item.nodeId;
    if (sameSpeaker && previous.kind === item.kind && (item.kind === 'text' || item.kind === 'thinking')) {
      output[output.length - 1] = { ...previous, at: item.at, [body]: previous[body] + item[body] };
    } else if (sameSpeaker && item.kind === 'result' && previous.kind === 'text' &&
        previous[body].trim() === item[body].trim()) {
      output[output.length - 1] = item;
    } else {
      output.push(item);
    }
  }
  return output;
}

export function replyFromOutput(items: readonly Fragment<'message'>[]): string {
  const text = items.filter((entry) => entry.kind === 'text').map((entry) => entry.message).join('');
  const final = items.filter((entry) => entry.kind === 'result').at(-1)?.message;
  return final && !text.trim().startsWith(final.trim()) ? final : text || final || '';
}
