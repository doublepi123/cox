export function CoxAppIcon(props: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label="Cox" className={props.className}>
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <path
        d="m25 20-12 12 12 12m14-24 12 12-12 12"
        fill="none"
        stroke="var(--background, #fff)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
