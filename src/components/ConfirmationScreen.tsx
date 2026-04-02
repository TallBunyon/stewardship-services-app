import type { LeadData } from '../types'

interface Props {
  leadData: LeadData
}

const SERVICE_LABELS: Record<string, string> = {
  'Website Design & Management': 'Website Design & Management',
  'AI Tool Stack Consultation': 'AI Tool Stack Consultation',
  'App Design & Development': 'App Design & Development',
}

export default function ConfirmationScreen({ leadData }: Props) {
  const serviceLabel = SERVICE_LABELS[leadData.service] ?? leadData.service

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
      <div className="w-full max-w-md animate-fadeIn">
        {/* Icon */}
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-[#2cc5a0]/10 border border-[#2cc5a0]/30 flex items-center justify-center">
            <CheckIcon />
          </div>
        </div>

        {/* Heading */}
        <div className="mb-8 text-center">
          <p className="mb-3 text-[11px] uppercase tracking-[0.24em] text-[#2cc5a0]/72">
            Intake complete
          </p>
          <h2 className="mb-2 text-xl font-semibold text-white">
            Thank you, {leadData.name}!
          </h2>
          <p className="text-sm leading-relaxed text-neutral-400">
            We will be in touch within <span className="text-[#2cc5a0]">24 hours</span>.
          </p>
        </div>

        {/* Summary card */}
        <div className="overflow-hidden rounded-[24px] border border-white/10 bg-[#171717] shadow-[0_24px_60px_rgba(0,0,0,0.25)]">
          <div className="border-b border-white/10 px-5 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/36">
              Submission Summary
            </p>
          </div>
          <div className="divide-y divide-white/10">
            <SummaryRow label="Name" value={leadData.name} />
            <SummaryRow label="Email" value={leadData.email} />
            {leadData.org && <SummaryRow label="Organization" value={leadData.org} />}
            <SummaryRow label="Service" value={serviceLabel} highlight />
            <SummaryRow label="Summary" value={leadData.summary} />
          </div>
        </div>

        {/* Mission note */}
        <div className="mt-6 rounded-2xl border border-[#2cc5a0]/15 bg-[#2cc5a0]/5 px-4 py-4">
          <p className="text-center text-xs leading-relaxed text-white/42">
            Your engagement helps fund <span className="text-[#2cc5a0]/80">Node Zero</span> —
            compute infrastructure designed to belong to the landscape it lives in.
          </p>
        </div>
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  value,
  highlight,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex gap-4 px-5 py-3">
      <span className="w-24 flex-shrink-0 pt-0.5 text-xs text-white/34">{label}</span>
      <span
        className={`text-sm leading-relaxed break-words min-w-0 ${
          highlight ? 'text-[#2cc5a0] font-medium' : 'text-neutral-300'
        }`}
      >
        {value}
      </span>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2cc5a0"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-7 h-7"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
