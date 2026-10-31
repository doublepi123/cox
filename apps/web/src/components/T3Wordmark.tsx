import type { SVGProps } from "react";

export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 96 40" xmlns="http://www.w3.org/2000/svg" aria-label="Cox">
      <text
        x="1"
        y="32"
        fill="currentColor"
        fontFamily="ui-monospace, monospace"
        fontSize="38"
        fontWeight="700"
      >
        Cox
      </text>
    </svg>
  );
}
