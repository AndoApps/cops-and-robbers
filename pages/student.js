import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'
import { COLS, ROWS, SYMBOLS, GRID_CONTENTS, formatDollars, shuffle } from '../lib/gameLogic'

export default function Student() {
  const router = useRouter()
  const { code, name } = router.query

  const [phase, setPhase] = useState('joining')
  const [gameId, setGameId] = useState(null)
  const [studentId, setStudentId] = useState(null)
  const [grid, setGrid] = useState(null)
  const [calledRefs, setCalledRefs] = useState([])
  const [currentRef, setCurrentRef] = useState(null)
  const [pointsInPlay, setPointsInPlay] = useState(0)
  const [pointsBanked, setPointsBanked] = useState(0)
  const [bulletproof, setBulletproof] = useState(false)
  const [frameJob, setFrameJob] = useState(false)
  const [notification, setNotification] = useState(null)
  const [scoreAnimating, setScoreAnimating] = useState(false)
  const [dragItem, setDragItem] = useState(null)
  const [isCuffed, setIsCuffed] = useState(false)
  const [canPickSquare, setCanPickSquare] = useState(false)
  const [myPlace, setMyPlace] = useState(null)
  const [myFinalScore, setMyFinalScore] = useState(null)
  const [podiumVisible, setPodiumVisible] = useState(false)
  const [podiumData, setPodiumData] = useState(null)
  const [leavePrompt, setLeavePrompt] = useState(false)
  const studentIdRef = useRef(null)
  const notificationTimer = useRef(null)

  useEffect(() => {
    if (code && name) joinGame()
  }, [code, name])

  const joinGame = async () => {
    const { data: game } = await supabase.from('games').select('*').eq('code', code).eq('phase', 'lobby').single()
    if (!game) {
      alert('Game not found or already started. Check your code!')
      router.push('/')
      return
    }
    const { data: student } = await supabase.from('students').insert({
      game_id: game.id,
      name: decodeURIComponent(name),
      phase: 'setup',
      points_in_play: 0,
      points_banked: 0,
      bulletproof: false,
      frame_job: false,
      cuffed: false,
      active: true,
      grid: null,
    }).select().single()
    if (!student) { alert('Could not join game'); return }
    setGameId(game.id)
    setStudentId(student.id)
    studentIdRef.current = student.id
    setPhase('setup')
    initGrid()
    subscribeToGame(game.id, student.id)
    subscribeToMyRecord(student.id)
  }

  const initGrid = () => {
    const contents = shuffle([...GRID_CONTENTS])
    setGrid(contents)
  }

  const subscribeToGame = (gid, sid) => {
    supabase.channel(`game-student-${gid}-${sid}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gid}` }, (payload) => {
        const g = payload.new
        if (g.phase) setPhase(g.phase)
        if (g.called_refs) setCalledRefs(g.called_refs)
        if (g.current_ref) setCurrentRef(g.current_ref)
        if (g.phase === 'ended' && g.final_scores) {
          handleGameEnd(g.final_scores, sid)
        }
      })
      .subscribe()
  }

  const subscribeToMyRecord = (sid) => {
    supabase.channel(`my-record-${sid}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'students', filter: `id=eq.${sid}` }, (payload) => {
        const s = payload.new
        if (s.points_in_play !== undefined) {
          setPointsInPlay(prev => {
            if (prev !== s.points_in_play) {
              setScoreAnimating(true)
              setTimeout(() => setScoreAnimating(false), 800)
            }
            return s.points_in_play
          })
        }
        if (s.points_banked !== undefined) setPointsBanked(s.points_banked)
        if (s.bulletproof !== undefined) setBulletproof(s.bulletproof)
        if (s.frame_job !== undefined) setFrameJob(s.frame_job)
        if (s.notification) {
          handleNotification(s.notification, sid)
        }
        if (s.leaving === false && leavePrompt) setLeavePrompt(false)
      })
      .subscribe()
  }

  const handleNotification = async (notif, sid) => {
    if (notif.type === 'DEFENCE_PROMPT') {
      setNotification({ ...notif, isDefencePrompt: true })
    } else if (notif.type === 'TIP_OFF_ACTIVATE') {
      setCanPickSquare(true)
      setNotification({ message: '📻 Pick your square! Tap any available cell!', isInfo: true })
    } else if (notif.type === 'LEAVE_DENIED') {
      setLeavePrompt(false)
      setNotification({ message: notif.message, isInfo: true })
      setTimeout(() => setNotification(null), 3000)
    } else {
      setNotification({ message: notif.message, isInfo: true })
      if (notificationTimer.current) clearTimeout(notificationTimer.current)
      notificationTimer.current = setTimeout(() => setNotification(null), 4000)
    }
    await supabase.from('students').update({ notification: null }).eq('id', sid)
  }

  const handleGameEnd = (scores, sid) => {
    const myScore = scores.find(s => s.id === sid)
    const myRank = scores.findIndex(s => s.id === sid) + 1
    setMyPlace(myRank)
    setMyFinalScore(myScore)
    setPodiumData(scores.slice(0, 3))
    setPhase('ended')
    setTimeout(() => setPodiumVisible(true), 500)
  }

  const handleDragStart = (idx) => {
    if (isCuffed) return
    setDragItem(idx)
  }

  const handleDrop = (idx) => {
    if (isCuffed || dragItem === null || dragItem === idx) return
    const newGrid = [...grid]
    const temp = newGrid[dragItem]
    newGrid[dragItem] = newGrid[idx]
    newGrid[idx] = temp
    setGrid(newGrid)
    setDragItem(null)
  }

  const handleAutoPopulate = () => {
    if (isCuffed) return
    setGrid(shuffle([...GRID_CONTENTS]))
  }

  const handleCuffIt = async () => {
    if (!grid) return
    await supabase.from('students').update({ grid, cuffed: true }).eq('id', studentId)
    setIsCuffed(true)
    setPhase('waiting')
  }

  const handleDefenceResponse = async (use, type = null) => {
    await supabase.from('students').update({ defence_response: { used: use, type } }).eq('id', studentId)
    setNotification(null)
  }

  const handleCellClick = async (idx) => {
    if (!canPickSquare) return
    const col = COLS[Math.floor(idx / 7)]
    const row = ROWS[idx % 7]
    const ref = `${col}${row}`
    if (calledRefs.includes(ref)) return
    setCanPickSquare(false)
    setNotification(null)
    await supabase.from('students').update({ tip_off_pick: ref }).eq('id', studentId)
    setTimeout(async () => {
      await supabase.from('students').update({ tip_off_pick: null }).eq('id', studentId)
    }, 2000)
  }

  const confirmLeave = async () => {
    await supabase.from('students').update({ active: false, leaving: false }).eq('id', studentId)
    router.push('/')
  }

  if (phase === 'joining') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0a0f' }}>
        <div className="text-center">
          <div className="text-4xl mb-4 animate-bounce">🚔</div>
          <p className="text-gray-500 tracking-widest">JOINING GAME...</p>
        </div>
      </div>
    )
  }

  if (phase === 'ended') {
    return (
      <StudentEndScreen
        myPlace={myPlace}
        myScore={myFinalScore}
        podiumData={podiumData}
        podiumVisible={podiumVisible}
        studentId={studentId}
      />
    )
  }

  return (
    <div className="min-h-screen flex flex-col p-3" style={{ background: '#0a0a0f', maxWidth: '500px', margin: '0 auto' }}>
      <div className="flex justify-between items-center mb-3">
        <div>
          <p className="text-xs text-gray-600 tracking-widest">PLAYING AS</p>
          <p className="font-bold" style={{ color: '#fbbf24' }}>{name ? decodeURIComponent(name) : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {phase === 'paused' && (
            <span className="text-xs px-2 py-1 rounded" style={{ background: '#1a1a2e', color: '#fbbf24', border: '1px solid #fbbf24' }}>⏸ PAUSED</span>
          )}
          {currentRef && phase === 'playing' && (
            <div className="text-center">
              <p className="text-xs text-gray-600">CALLED</p>
              <p className="text-2xl font-bold" style={{ color: '#ef4444' }}>{currentRef}</p>
            </div>
          )}
          <button onClick={() => setLeavePrompt(true)} className="text-xs text-gray-700 hover:text-gray-500 px-2 py-1">✕</button>
        </div>
      </div>

      {notification && (
        <div className="rounded-xl p-4 mb-3 animate-bounce-in" style={{ background: '#1a1a2e', border: `2px solid ${notification.isDefencePrompt ? '#ef4444' : '#374151'}` }}>
          <p className="text-sm text-center mb-3">{notification.message}</p>
          {notification.isDefencePrompt && (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  const hasBoth = notification.hasBulletproof && notification.hasFrameJob
                  if (hasBoth) {
                    setNotification({ ...notification, choosingDefence: true })
                  } else {
                    const type = notification.hasBulletproof ? 'BULLETPROOF' : 'FRAME_JOB'
                    handleDefenceResponse(true, type)
                  }
                }}
                className="w-full py-3 rounded-xl font-bold tracking-wider"
                style={{ background: '#22c55e', color: 'white' }}
              >
                🛡️ USE DEFENCE
              </button>
              {notification.choosingDefence && (
                <div className="flex gap-2">
                  {notification.hasBulletproof && (
                    <button onClick={() => handleDefenceResponse(true, 'BULLETPROOF')} className="flex-1 py-2 rounded-lg text-sm font-bold" style={{ background: '#1a3a1a', border: '1px solid #22c55e', color: '#22c55e' }}>🦺 Bulletproof</button>
                  )}
                  {notification.hasFrameJob && (
                    <button onClick={() => handleDefenceResponse(true, 'FRAME_JOB')} className="flex-1 py-2 rounded-lg text-sm font-bold" style={{ background: '#1a1a3a', border: '1px solid #818cf8', color: '#818cf8' }}>🪞 Frame Job</button>
                  )}
                </div>
              )}
              <button
                onClick={() => handleDefenceResponse(false)}
                className="w-full py-2 rounded-xl text-sm"
                style={{ background: '#1a1a1a', border: '1px solid #374151', color: '#9ca3af' }}
              >
                No thanks
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 mb-3">
        <div className="grid grid-cols-8 gap-1 mb-1">
          <div />
          {COLS.map(c => <div key={c} className="text-center text-xs text-gray-600 font-bold">{c}</div>)}
        </div>
        {ROWS.map((row, rowIdx) => (
          <div key={row} className="grid grid-cols-8 gap-1 mb-1">
            <div className="text-xs text-gray-600 font-bold flex items-center justify-center">{row}</div>
            {COLS.map((col, colIdx) => {
              const idx = colIdx * 7 + rowIdx
              const cell = grid ? grid[idx] : null
              const ref = `${col}${row}`
              const called = calledRefs.includes(ref)
              const isCurrent = ref === currentRef
              const isPickable = canPickSquare && !called
              return (
                <div
                  key={ref}
                  className={`aspect-square rounded flex flex-col items-center justify-center text-xs transition-all select-none`}
                  style={{
                    background: isCurrent ? '#2a1500' : called ? '#0d0d10' : '#1a1a2e',
                    border: isCurrent ? '2px solid #fbbf24' : isPickable ? '2px solid #22c55e' : '1px solid #222',
                    opacity: called ? 0.3 : 1,
                    cursor: isCuffed && !isPickable ? 'default' : isPickable ? 'pointer' : isCuffed ? 'default' : 'grab',
                    filter: called ? 'grayscale(1)' : 'none',
                  }}
                  draggable={!isCuffed && !called}
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={e => e.preventDefault()}
                  onDrop={() => handleDrop(idx)}
                  onClick={() => isPickable && handleCellClick(idx)}
                >
                  {cell && (
                    <>
                      {cell.type === 'symbol' ? (
                        <span className="text-base leading-none">{SYMBOLS[cell.value]?.icon}</span>
                      ) : (
                        <span className="font-bold text-center leading-tight" style={{ color: '#22c55e', fontSize: '9px' }}>
                          ${cell.value >= 1000 ? `${cell.value/1000}K` : cell.value}
                        </span>
                      )}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {(phase === 'setup' || phase === 'waiting') && !isCuffed && (
        <div className="flex gap-3 mb-3">
          <button onClick={handleAutoPopulate} className="flex-1 py-2 rounded-xl text-sm font-bold tracking-wider" style={{ background: '#1a1a2e', border: '1px solid #374151', color: '#9ca3af' }}>
            🎲 AUTO
          </button>
          <button onClick={handleCuffIt} className="flex-1 py-3 rounded-xl font-bold tracking-wider text-lg" style={{ background: '#ef4444', color: 'white', border: '2px solid #ef4444' }}>
            🔒 CUFF IT IN
          </button>
        </div>
      )}

      {isCuffed && phase === 'waiting' && (
        <div className="text-center py-3 mb-3 rounded-xl animate-fade-in" style={{ background: '#0a1a0a', border: '1px solid #22c55e' }}>
          <p className="text-sm tracking-widest" style={{ color: '#22c55e' }}>🔒 CUFFED IN — Waiting for game to start...</p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-2">
        <div className="rounded-xl p-2 text-center" style={{ background: '#111', border: '1px solid #333' }}>
          <p className="text-xs text-gray-600 mb-1">🏦</p>
          <p className={`font-bold text-sm ${scoreAnimating ? 'animate-slot' : ''}`} style={{ color: '#22c55e' }}>{formatDollars(pointsBanked)}</p>
        </div>
        <div className="rounded-xl p-2 text-center" style={{ background: '#111', border: '1px solid #333' }}>
          <p className="text-xs text-gray-600 mb-1">💵</p>
          <p className={`font-bold text-sm ${scoreAnimating ? 'animate-slot' : ''}`} style={{ color: '#fbbf24' }}>{formatDollars(pointsInPlay)}</p>
        </div>
        <div className="rounded-xl p-2 text-center" style={{ background: '#111', border: `1px solid ${bulletproof ? '#22c55e' : '#222'}` }}>
          <p className="text-xs mb-1">🦺</p>
          <div className="w-3 h-3 rounded-full mx-auto" style={{ background: bulletproof ? '#22c55e' : '#333' }} />
        </div>
        <div className="rounded-xl p-2 text-center" style={{ background: '#111', border: `1px solid ${frameJob ? '#818cf8' : '#222'}` }}>
          <p className="text-xs mb-1">🪞</p>
          <div className="w-3 h-3 rounded-full mx-auto" style={{ background: frameJob ? '#818cf8' : '#333' }} />
        </div>
      </div>

      {leavePrompt && (
        <div className="popup-overlay">
          <div className="rounded-2xl p-6 w-72 text-center" style={{ background: '#111', border: '1px solid #ef4444' }}>
            <p className="text-lg font-bold mb-2" style={{ color: '#ef4444' }}>Leave game?</p>
            <p className="text-sm text-gray-500 mb-6">Your teacher must approve. Your points will be lost.</p>
            <div className="flex gap-3">
              <button onClick={confirmLeave} className="flex-1 py-2 rounded-lg text-sm font-bold" style={{ background: '#ef4444', color: 'white' }}>Leave</button>
              <button onClick={() => { setLeavePrompt(false); supabase.from('students').update({ leaving: false }).eq('id', studentId) }} className="flex-1 py-2 rounded-lg text-sm" style={{ background: '#333', color: 'white' }}>Stay</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StudentEndScreen({ myPlace, myScore, podiumData, podiumVisible, studentId }) {
  const medals = ['🥇', '🥈', '🥉']
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#0a0a0f' }}>
      {podiumVisible && (
        <>
          <h2 className="text-2xl font-bold tracking-widest mb-8 animate-fade-in" style={{ color: '#fbbf24' }}>🚨 GAME OVER 🚨</h2>
          <div className="flex items-end gap-4 mb-10">
            {[1, 0, 2].map((rankIdx) => {
              const s = podiumData?.[rankIdx]
              if (!s) return null
              const isMe = s.id === studentId
              const heights = ['h-24', 'h-32', 'h-16']
              return (
                <div key={rankIdx} className="text-center animate-slide-up" style={{ animationDelay: `${rankIdx * 0.5}s` }}>
                  <p className="text-2xl mb-1">{medals[rankIdx]}</p>
                  <div className={`rounded-xl px-4 py-3 ${heights[rankIdx]} flex flex-col items-center justify-center w-24`} style={{ background: isMe ? '#1a1500' : '#1a1a2e', border: `2px solid ${isMe ? '#fbbf24' : '#374151'}` }}>
                    <p className="font-bold text-xs truncate w-full text-center">{s.name}</p>
                    <p className="text-xs" style={{ color: '#22c55e' }}>{formatDollars(s.total)}</p>
                  </div>
                </div>
              )
            })}
          </div>
          {myScore && (
            <div className="rounded-2xl p-6 text-center w-full max-w-xs animate-bounce-in" style={{ background: '#111', border: `2px solid ${myPlace <= 3 ? '#fbbf24' : '#374151'}` }}>
              <p className="text-xs text-gray-600 tracking-widest mb-2">YOUR RESULT</p>
              {myPlace <= 3 && <p className="text-4xl mb-2">{medals[myPlace - 1]}</p>}
              {myPlace > 3 && <p className="text-2xl mb-2">#{myPlace}</p>}
              <p className="text-3xl font-bold mb-1" style={{ color: '#fbbf24' }}>{formatDollars(myScore.total)}</p>
              <div className="flex justify-center gap-4 text-sm text-gray-500 mt-2">
                <span>🏦 {formatDollars(myScore.banked)}</span>
                <span>+ 💵 {formatDollars(myScore.inPlay)}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
