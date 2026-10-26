import { createRoot } from 'react-dom/client';
import { ProposalDiagnostics } from '../../src/renderer/features/review-analysis-proposals/ui/ProposalDiagnostics';
import { proposalSchema } from '../../src/renderer/features/review-analysis-proposals/model/analysisProposal.schema';
import '../../src/renderer/shared/theme/tokens.css';
const element = document.getElementById('root');
if (!element) throw new Error('fixture root missing');
const root = createRoot(element);
window.addEventListener('ui8-report', (event: Event): void => {
  if (!(event instanceof CustomEvent)) return;
  const record = proposalSchema.parse(event.detail);
  root.render(
    <div className="wiki-theme">
      <ProposalDiagnostics record={record} report={null} />
    </div>,
  );
});
