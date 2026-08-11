// Orchestration ("Agent SDK") provider mark: a hub (orchestrator) connected to
// three spokes (subagents). Inline SVG so there's no external asset dependency;
// amber to distinguish it in the provider selector.
const OrchestrationLogo = ({ className = 'w-5 h-5' }: { className?: string }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="#f59e0b"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role="img"
      aria-label="Agent SDK"
    >
      <path d="M12 9V5" />
      <path d="M12 15l-4.2 3.2" />
      <path d="M12 15l4.2 3.2" />
      <circle cx="12" cy="12" r="2.6" fill="#f59e0b" stroke="none" />
      <circle cx="12" cy="4" r="1.8" />
      <circle cx="6.5" cy="19" r="1.8" />
      <circle cx="17.5" cy="19" r="1.8" />
    </svg>
  );
};

export default OrchestrationLogo;
