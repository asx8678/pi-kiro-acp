// Separate runtime process for the offline shared-conversation regression.
import { ProviderRuntime } from '../dist/src/provider/runtime.js';
import { context, model, collect } from '../dist/tests/helpers.js';
const config = JSON.parse(process.env.OWNER_CONFIG);
const runtime = new ProviderRuntime(config);
process.on('message', async message => {
  try {
    if (message === 'run') {
      const answer = await collect(runtime.generate(model(config), context(), { sessionId: 'shared-conversation' }));
      process.send({ type: 'answer', answer });
    } else if (message === 'claim') {
      runtime.journal.reserveBinding('orphaned');
      process.send({ type: 'claimed' });
    } else if (message === 'close') {
      await runtime.close();
      process.disconnect();
    }
  } catch (error) { process.send({ type: 'failure', message: String(error) }); }
});
process.send({ type: 'ready' });
