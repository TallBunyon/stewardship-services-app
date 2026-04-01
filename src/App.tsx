import { useChat } from './hooks/useChat'
import ChatWindow from './components/ChatWindow'
import ConfirmationScreen from './components/ConfirmationScreen'

export default function App() {
  const { messages, isTyping, appState, leadData, sendMessage } = useChat()

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-[#2a2a2a] px-4 py-3 sm:px-6">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-full bg-[#2cc5a0]/10 border border-[#2cc5a0]/30 flex items-center justify-center">
              <div className="w-2.5 h-2.5 rounded-full bg-[#2cc5a0]" />
            </div>
            <span className="absolute bottom-0 right-0 block w-2 h-2 rounded-full bg-[#2cc5a0] ring-1 ring-[#0d0d0d]" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white leading-tight">
              Steward{' '}
              <span className="text-[#2cc5a0]/60 font-normal">—</span>{' '}
              <span className="text-[#2cc5a0]/80 font-normal">Stewardship Compute</span>
            </h1>
            <p className="text-[11px] text-neutral-500 leading-tight tracking-wide uppercase">
              Stability Through Stewardship
            </p>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden max-w-2xl w-full mx-auto flex flex-col">
        {appState === 'confirmed' && leadData ? (
          <ConfirmationScreen leadData={leadData} />
        ) : (
          <ChatWindow
            messages={messages}
            isTyping={isTyping}
            appState={appState}
            onSend={sendMessage}
          />
        )}
      </main>
    </div>
  )
}
