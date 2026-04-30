import { useChat } from './hooks/useChat'
import ChatWindow from './components/ChatWindow'

export default function App() {
  const { messages, isTyping, appState, sendMessage } = useChat()

  return (
    <div className="flex min-h-full flex-col bg-[#0d0d0d] text-white">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <div className="hero-glow hero-glow--left" />
        <div className="hero-glow hero-glow--right" />
      </div>

      <header className="relative flex-shrink-0 border-b border-white/10 bg-[#111111]/85 backdrop-blur px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#2cc5a0]/35 bg-[#2cc5a0]/10 shadow-[0_0_24px_rgba(44,197,160,0.12)]">
                <div className="h-2.5 w-2.5 rounded-full bg-[#2cc5a0]" />
              </div>
              <span className="absolute bottom-0 right-0 block h-2.5 w-2.5 rounded-full bg-[#2cc5a0] ring-2 ring-[#111111]" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.26em] text-[#2cc5a0]/80">
                Stewardship Compute LLC
              </p>
              <h1 className="text-base font-semibold leading-tight text-white sm:text-lg">
                Steward
              </h1>
              <p className="text-[11px] uppercase tracking-[0.18em] text-white/45">
                Stability Through Stewardship
              </p>
            </div>
          </div>

          <div className="hidden md:block text-right">
            <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Services Intake</p>
            <p className="text-xs text-white/55">Digital infrastructure, rooted somewhere.</p>
          </div>
        </div>
      </header>

      <main className="relative flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.1fr_1.5fr] lg:gap-8">
          <section className="hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(18,18,18,0.94),rgba(13,13,13,0.98))] p-8 shadow-[0_24px_80px_rgba(0,0,0,0.35)] lg:flex lg:flex-col lg:justify-between overflow-hidden relative">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#2cc5a0]/40 to-transparent" />
            <div>
              <p className="mb-4 text-[11px] uppercase tracking-[0.28em] text-[#2cc5a0]/75">
                Stewardship is not a concept.
              </p>
              <h2 className="max-w-md text-[2rem] font-semibold leading-[1.1] text-white xl:text-[2.45rem]">
                It is what happens when infrastructure is designed to belong.
              </h2>
              <div className="mt-5 max-w-md space-y-3 text-sm leading-7 text-white/58">
                <p>When technology lives inside the landscape instead of above it.</p>
                <p>When decisions are made in the open. When energy is accounted for. When water is measured.</p>
                <p>This is the front door for the work that funds that mission.</p>
              </div>
            </div>

            <div className="space-y-5 pt-8">
              <div className="rounded-2xl border border-white/8 bg-white/[0.02] px-5 py-4">
                <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">What happens here</p>
                <p className="mt-2 text-sm leading-7 text-white/58">
                  Steward qualifies needs, recommends the right service, and routes serious inquiries into a revenue path that supports Node Zero.
                </p>
              </div>
              <ValueLine
                label="Website Design & Management"
                text="Professional web presence, built clean and maintained with care."
              />
              <ValueLine
                label="AI Tool Stack Consultation"
                text="Practical implementation guidance without the hype cycle."
              />
              <ValueLine
                label="App Design & Development"
                text="Custom software for businesses that need something real built."
              />
            </div>
          </section>

          <section className="overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(20,20,20,0.96),rgba(11,11,11,0.98))] shadow-[0_24px_80px_rgba(0,0,0,0.42)] min-h-[70vh] flex flex-col">
            <ChatWindow
              messages={messages}
              isTyping={isTyping}
              appState={appState}
              onSend={sendMessage}
            />
          </section>
        </div>
      </main>
    </div>
  )
}

function ValueLine({ label, text }: { label: string; text: string }) {
  return (
    <div className="border-l border-[#2cc5a0]/30 pl-4">
      <p className="text-sm font-medium text-white">{label}</p>
      <p className="mt-1 text-sm leading-6 text-white/50">{text}</p>
    </div>
  )
}
