import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { generateGameCode, generateCallOrder, COLS, ROWS, SYMBOLS, ACTION_SYMBOLS, formatDollars, shuffle, GRID_CONTENTS } from '../lib/gameLogic'
 
const DEFENCE_COUNTDOWN = 5
 
export default function Teacher() {
  const [phase, setPhase] = useState('lobby') // lobby, setup, playing, paused, ended
  const [gameCode, setGameCode] = useState('')
  const [gameId, setGameId] = useState(null)
  const [students, setStudents] = useState([]) // { id, name, cuffed, points_in_play, points_banked, bulletproof, frame_job, grid }
  const [callOrder, setCallOrder] = useState([])
  const [calledRefs, setCalledRefs] = useState([])
  const [currentRef, setCurrentRef] = useState(null)
  const [actionsBox, setActionsBox] = useState([]) // [{ studentId, studentName, symbol, processed }]
  const [pickNextBox, setPickNextBox] = useState([]) // [{ studentId, studentName }]
  const [activeAction, setActiveAction] = useState(null) // current action being processed
  const [awaitingTarget, setAwaitingTarget] = useState(false)
  const [defenceCountdown, setDefenceCountdown] = useState(null)
  const [defenceTimer, setDefenceTimer] = useState(null)
  const [defenceResponse, setDefenceResponse] = useState(null) // { used: bool, type: string }
  const [tipOffCountdown, setTipOffCountdown] = useState(null)
  const [tipOffTimer, setTipOffTimer] = useState(null)
  const [activeTipOff, setActiveTipOff] = useState(null)
  const [notification, setNotification] = useState('')
  const [podiumData, setPodiumData] = useState(null)
  const [scoreOverride, setScoreOverride] = useState({ show: false, studentId: null, value: '' })
  const channelRef = useRef(null)
  const gameIdRef = useRef(null)
 
  // Create game on mount
  useEffect(() => {
    createGame()
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current)
    }
  }, [])
 
  const createGame = async () => {
    const code = generateGameCode()
    setGameCode(code)
    const order = generateCallOrder()
    setCallOrder(order)
 
    const { data, error } = await supabase.from('games').insert({
      code,
      phase: 'lobby',
      call_order: order,
      called_refs: [],
      current_ref: null,
      actions_box: [],
      pick_next_box: [],
      current_action: null,
    }).select().single()
 
    if (error) { console.error(error); return }
    setGameId(data.id)
    gameIdRef.current = data.id
    subscribeToGame(data.id)
    subscribeToStudents(data.id)
  }
 
  const subscribeToGame = (gid) => {
    const channel = supabase.channel(`game-${gid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gid}` }, (payload) => {
        // teacher is source of truth, no need to update from db
      })
      .subscribe()
    channelRef.current = channel
  }
 
  const subscribeToStudents = (gid) => {
    supabase.channel(`students-teacher-${gid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students', filter: `game_id=eq.${gid}` }, async (payload) => {
        // Reload all students
        const { data } = await supabase.from('students').select('*').eq('game_id', gid).order('name')
        if (data) setStudents(data)
        
        // Check for defence responses
        if (payload.new && payload.new.defence_response !== null && payload.new.defence_response !== undefined) {
          setDefenceResponse(payload.new.defence_response)
        }
 
        // Check for tip-off picks
        if (payload.new && payload.new.tip_off_pick) {
          handleTipOffPick(payload.new.tip_off_pick, payload.new.id)
        }
 
        // Check for leaving
        if (payload.new && payload.new.leaving === true) {
          setNotification(`⚠️ ${payload.new.name} wants to leave the game`)
        }
      })
      .subscribe()
  }
 
  // Watch for defence response
  useEffect(() => {
    if (defenceResponse && activeAction) {
      clearInterval(defenceTimer)
      setDefenceCountdown(null)
      resolveDefence(defenceResponse)
    }
  }, [defenceResponse])
 
  const resolveDefence = async (response) => {
    const { used, type } = response
    const { attackerId, targetId, symbol } = activeAction
 
    if (!used) {
      // Defence not used — attack goes through
      await executeAttack(attackerId, targetId, symbol, false, null)
    } else if (type === 'BULLETPROOF') {
      // Attack blocked
      setNotification(`🦺 ${getStudentName(targetId)} used Bulletproof — attack blocked!`)
      await updateStudentDefence(targetId, 'bulletproof', false)
      finishAction()
    } else if (type === 'FRAME_JOB') {
      // Attack reversed
      setNotification(`🪞 ${getStudentName(targetId)} used Frame Job — attack reversed!`)
      await updateStudentDefence(targetId, 'frame_job', false)
      await executeAttack(targetId, attackerId, symbol, true, null) // reversed
    }
    setDefenceResponse(null)
  }
 
  const getStudentName = (id) => {
    const s = students.find(s => s.id === id)
    return s ? s.name : 'Unknown'
  }
 
  const getStudent = (id) => students.find(s => s.id === id)
 
  // Start game
  const startGame = async () => {
    await supabase.from('games').update({ phase: 'playing' }).eq('id', gameId)
    await supabase.from('students').update({ phase: 'playing' }).eq('game_id', gameId)
    setPhase('playing')
  }
 
  // Call next square
  const callNext = async () => {
    if (actionsBox.length > 0 || pickNextBox.length > 0) return
 
    const nextIdx = calledRefs.length
    if (nextIdx >= callOrder.length) {
      endGame()
      return
    }
 
    const ref = callOrder[nextIdx]
    setCurrentRef(ref)
    const newCalled = [...calledRefs, ref]
    setCalledRefs(newCalled)
 
    // Broadcast to all students
    await supabase.from('games').update({
      current_ref: ref,
      called_refs: newCalled,
      phase: 'playing',
    }).eq('id', gameId)
 
    // Process each student's cell at this ref
    await processRefForAllStudents(ref, newCalled)
  }
 
  const processRefForAllStudents = async (ref, newCalled) => {
    const col = ref[0]
    const row = parseInt(ref[1])
    const colIdx = COLS.indexOf(col)
    const rowIdx = row - 1
    const cellIdx = colIdx * 7 + rowIdx
 
    const newActions = []
    const newPickNext = []
 
    for (const student of students) {
      if (!student.grid) continue
      const cell = student.grid[cellIdx]
      if (!cell) continue
 
      if (cell.type === 'points') {
        // Auto add points
        const newPoints = (student.points_in_play || 0) + cell.value
        await supabase.from('students').update({ points_in_play: newPoints }).eq('id', student.id)
        // Broadcast score update
        await supabase.from('games').update({ [`score_update_${student.id}`]: { id: student.id, points: newPoints, animate: true } }).eq('id', gameId)
      } else if (cell.type === 'symbol') {
        const sym = cell.value
 
        if (sym === 'VAULT') {
          // Auto bank
          const newBank = (student.points_banked || 0) + (student.points_in_play || 0)
          await supabase.from('students').update({ points_banked: newBank, points_in_play: 0 }).eq('id', student.id)
          await notifyStudent(student.id, { type: 'VAULT', message: '🏦 Your points have been banked!' })
        } else if (sym === 'CRIME_SPREE') {
          // Auto double
          const newPoints = (student.points_in_play || 0) * 2
          await supabase.from('students').update({ points_in_play: newPoints }).eq('id', student.id)
          await notifyStudent(student.id, { type: 'CRIME_SPREE', message: '⚡ Crime Spree! Your points doubled!' })
        } else if (sym === 'BULLETPROOF') {
          await supabase.from('students').update({ bulletproof: true }).eq('id', student.id)
          await notifyStudent(student.id, { type: 'BULLETPROOF', message: '🦺 Bulletproof vest acquired!' })
        } else if (sym === 'FRAME_JOB') {
          await supabase.from('students').update({ frame_job: true }).eq('id', student.id)
          await notifyStudent(student.id, { type: 'FRAME_JOB', message: '🪞 Frame Job acquired!' })
        } else if (sym === 'TIP_OFF') {
          newPickNext.push({ studentId: student.id, studentName: student.name })
        } else if (ACTION_SYMBOLS.includes(sym) && sym !== 'TIP_OFF') {
          newActions.push({ studentId: student.id, studentName: student.name, symbol: sym })
        }
      }
    }
 
    // Sort actions alphabetically
    newActions.sort((a, b) => a.studentName.localeCompare(b.studentName))
    newPickNext.sort((a, b) => a.studentName.localeCompare(b.studentName))
 
    if (newActions.length > 0) setActionsBox(newActions)
    if (newPickNext.length > 0) setPickNextBox(prev => [...prev, ...newPickNext])
 
    // Reload students after updates
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (data) setStudents(data)
  }
 
  const notifyStudent = async (studentId, notification) => {
    await supabase.from('students').update({ notification }).eq('id', studentId)
  }
 
  // Teacher clicks on a student name in actions box
  const handleActionStudent = (action) => {
    setActiveAction(action)
    setAwaitingTarget(true)
  }
 
  // Teacher clicks target student
  const handleSelectTarget = async (targetStudent) => {
    if (!activeAction) return
 
    const attacker = getStudent(activeAction.studentId)
    const target = targetStudent
 
    // Check if target has defence
    const hasDefence = target.bulletproof || target.frame_job
 
    if (hasDefence) {
      // Ask student if they want to use defence
      await notifyStudent(target.id, {
        type: 'DEFENCE_PROMPT',
        message: 'Do you want to use your defence?',
        attackSymbol: activeAction.symbol,
        attackerName: attacker?.name,
        hasBulletproof: target.bulletproof,
        hasFrameJob: target.frame_job,
      })
      setAwaitingTarget(false)
      startDefenceCountdown(target.id)
    } else {
      // No defence — execute immediately
      setAwaitingTarget(false)
      await executeAttack(activeAction.studentId, target.id, activeAction.symbol, false, null)
    }
  }
 
  const startDefenceCountdown = (targetId) => {
    setDefenceCountdown(DEFENCE_COUNTDOWN)
    const timer = setInterval(() => {
      setDefenceCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          // Auto resolve — no defence used
          executeAttack(activeAction.studentId, targetId, activeAction.symbol, false, null)
          return null
        }
        return prev - 1
      })
    }, 1000)
    setDefenceTimer(timer)
  }
 
  const executeAttack = async (attackerId, targetId, symbol, reversed, _) => {
    const attacker = getStudent(attackerId)
    const target = getStudent(targetId)
 
    if (!attacker || !target) { finishAction(); return }
 
    if (symbol === 'HEIST') {
      if (reversed) {
        // Frame job — target steals from attacker
        const stolen = attacker.points_in_play || 0
        await supabase.from('students').update({ points_in_play: (target.points_in_play || 0) + stolen }).eq('id', target.id)
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', attacker.id)
        setNotification(`💰 Frame Job! ${target.name} robbed ${attacker.name} instead!`)
      } else {
        const stolen = target.points_in_play || 0
        await supabase.from('students').update({ points_in_play: (attacker.points_in_play || 0) + stolen }).eq('id', attacker.id)
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', target.id)
        setNotification(`💰 ${attacker.name} robbed ${target.name}!`)
        await notifyStudent(target.id, { type: 'HEIST', message: `💰 You've been robbed by ${attacker.name}!` })
      }
    } else if (symbol === 'ARREST') {
      if (reversed) {
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', attacker.id)
        setNotification(`📜 Frame Job! ${target.name} turned the warrant on ${attacker.name}!`)
      } else {
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', target.id)
        setNotification(`📜 ${attacker.name} arrested ${target.name}! Points wiped!`)
        await notifyStudent(target.id, { type: 'ARREST', message: `📜 Arrest Warrant! Your points in play are gone!` })
      }
    } else if (symbol === 'SWITCHEROO') {
      if (reversed) {
        // In reversed switcheroo, effectively stays same but let's just show message
        setNotification(`🔄 Frame Job! Switcheroo blocked!`)
      } else {
        const aPoints = attacker.points_in_play || 0
        const tPoints = target.points_in_play || 0
        await supabase.from('students').update({ points_in_play: tPoints }).eq('id', attacker.id)
        await supabase.from('students').update({ points_in_play: aPoints }).eq('id', target.id)
        setNotification(`🔄 ${attacker.name} switched points with ${target.name}!`)
        await notifyStudent(target.id, { type: 'SWITCHEROO', message: `🔄 ${attacker.name} switched points with you!` })
      }
    } else if (symbol === 'INSIDE_JOB') {
      await supabase.from('students').update({ points_in_play: (target.points_in_play || 0) + 1000 }).eq('id', target.id)
      setNotification(`🤝 ${attacker.name} gave $1,000 to ${target.name}!`)
      await notifyStudent(target.id, { type: 'INSIDE_JOB', message: `🤝 ${attacker.name} gave you $1,000!` })
    }
 
    // Reload students
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (data) setStudents(data)
 
    finishAction()
  }
 
  const updateStudentDefence = async (studentId, type, value) => {
    await supabase.from('students').update({ [type]: value }).eq('id', studentId)
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (data) setStudents(data)
  }
 
  const finishAction = () => {
    const remaining = actionsBox.filter(a => a !== activeAction && a.studentId !== activeAction?.studentId)
    setActionsBox(remaining)
    setActiveAction(null)
    setAwaitingTarget(false)
    setDefenceCountdown(null)
  }
 
  // Tip Off handling
  const handleActivateTipOff = async (entry) => {
    setActiveTipOff(entry)
    // Tell student they can pick
    await notifyStudent(entry.studentId, { type: 'TIP_OFF_ACTIVATE', message: '📻 Pick the next square! You have 5 seconds!' })
    startTipOffCountdown(entry)
  }
 
  const startTipOffCountdown = (entry) => {
    setTipOffCountdown(DEFENCE_COUNTDOWN)
    const timer = setInterval(() => {
      setTipOffCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          setTipOffCountdown(null)
          // Random pick
          const available = callOrder.filter(r => !calledRefs.includes(r))
          if (available.length > 0) {
            const randomRef = available[Math.floor(Math.random() * available.length)]
            processTipOffPick(randomRef, entry.studentId, true)
          }
          return null
        }
        return prev - 1
      })
    }, 1000)
    setTipOffTimer(timer)
  }
 
  const handleTipOffPick = (ref, studentId) => {
    if (activeTipOff && activeTipOff.studentId === studentId) {
      clearInterval(tipOffTimer)
      setTipOffCountdown(null)
      processTipOffPick(ref, studentId, false)
    }
  }
 
  const processTipOffPick = async (ref, studentId, wasRandom) => {
    const studentName = getStudentName(studentId)
    setNotification(wasRandom ? `⏱️ Time up! Random square ${ref} selected` : `📻 ${studentName} picked square ${ref}!`)
    
    // Remove from pick next box
    setPickNextBox(prev => {
      const remaining = prev.filter(p => p.studentId !== studentId)
      return remaining
    })
    setActiveTipOff(null)
 
    // Call that ref
    setCurrentRef(ref)
    const newCalled = [...calledRefs, ref]
    setCalledRefs(newCalled)
 
    await supabase.from('games').update({
      current_ref: ref,
      called_refs: newCalled,
    }).eq('id', gameId)
 
    await processRefForAllStudents(ref, newCalled)
  }
 
  // Pause / resume
  const togglePause = async () => {
    const newPhase = phase === 'paused' ? 'playing' : 'paused'
    setPhase(newPhase)
    await supabase.from('games').update({ phase: newPhase }).eq('id', gameId)
    await supabase.from('students').update({ phase: newPhase }).eq('game_id', gameId)
  }
 
  // End game
  const endGame = async () => {
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (!data) return
 
    const finalScores = data.map(s => ({
      id: s.id,
      name: s.name,
      total: (s.points_banked || 0) + (s.points_in_play || 0),
      banked: s.points_banked || 0,
      inPlay: s.points_in_play || 0,
    })).sort((a, b) => b.total - a.total)
 
    setPodiumData(finalScores)
    setPhase('ended')
    await supabase.from('games').update({ phase: 'ended', final_scores: finalScores }).eq('id', gameId)
    await supabase.from('students').update({ phase: 'ended' }).eq('game_id', gameId)
  }
 
  // Score override
  const handleScoreOverride = async () => {
    const val = parseInt(scoreOverride.value)
    if (isNaN(val)) return
    await supabase.from('students').update({ points_in_play: val }).eq('id', scoreOverride.studentId)
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (data) setStudents(data)
    setScoreOverride({ show: false, studentId: null, value: '' })
  }
 
  // Approve/deny student leaving
  const handleLeaveDecision = async (studentId, approve) => {
    if (approve) {
      await supabase.from('students').update({ active: false, leaving: false }).eq('id', studentId)
      setNotification('')
    } else {
      await supabase.from('students').update({ leaving: false }).eq('id', studentId)
      await notifyStudent(studentId, { type: 'LEAVE_DENIED', message: '🚫 Your teacher says stay in the game!' })
      setNotification('')
    }
    const { data } = await supabase.from('students').select('*').eq('game_id', gameId).order('name')
    if (data) setStudents(data)
  }
 
  const activeStudents = students.filter(s => s.active !== false)
  const cuffedCount = activeStudents.filter(s => s.cuffed).length
  const canStart = cuffedCount > 0 && cuffedCount === activeStudents.length
 
  const nextButtonDisabled = actionsBox.length > 0 || pickNextBox.length > 0 || phase === 'paused'
  const allCalled = calledRefs.length >= 49
 
  // ============================================================
  // RENDER
  // ============================================================
 
  if (phase === 'ended' && podiumData) {
    return <PodiumScreen scores={podiumData} />
  }
 
  return (
    <div className="min-h-screen p-4" style={{ background: '#0a0a0f' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-widest" style={{ color: '#ef4444' }}>COPS &amp; ROBBERS</h1>
          <p className="text-xs text-gray-600 tracking-widest">TEACHER CONTROL</p>
        </div>
        <div className="flex items-center gap-3">
          {phase === 'playing' && (
            <button onClick={togglePause} className="px-4 py-2 rounded-lg text-sm font-bold tracking-wider" style={{ background: '#1a1a2e', border: '1px solid #fbbf24', color: '#fbbf24' }}>
              ⏸ PAUSE
            </button>
          )}
          {phase === 'paused' && (
            <button onClick={togglePause} className="px-4 py-2 rounded-lg text-sm font-bold tracking-wider animate-pulse" style={{ background: '#1a1a2e', border: '1px solid #22c55e', color: '#22c55e' }}>
              ▶ RESUME
            </button>
          )}
          <div className="text-right">
            <p className="text-xs text-gray-600">SQUARES CALLED</p>
            <p className="text-xl font-bold" style={{ color: '#fbbf24' }}>{calledRefs.length}/49</p>
          </div>
        </div>
      </div>
 
      {/* LOBBY PHASE */}
      {phase === 'lobby' && (
        <LobbyScreen
          gameCode={gameCode}
          students={activeStudents}
          cuffedCount={cuffedCount}
          canStart={canStart}
          onStart={startGame}
        />
      )}
 
      {/* PLAYING PHASE */}
      {(phase === 'playing' || phase === 'paused') && (
        <div className="grid grid-cols-3 gap-4">
          {/* Left: Grid display */}
          <div className="col-span-1">
            <TeacherGrid calledRefs={calledRefs} currentRef={currentRef} />
          </div>
 
          {/* Middle: Main controls */}
          <div className="col-span-1 flex flex-col gap-4">
            {/* Current ref */}
            <div className="rounded-xl p-4 text-center" style={{ background: '#111', border: '1px solid #333' }}>
              <p className="text-xs text-gray-600 tracking-widest mb-1">CURRENT SQUARE</p>
              <p className="text-6xl font-bold" style={{ color: '#fbbf24' }}>{currentRef || '—'}</p>
            </div>
 
            {/* Next button */}
            <button
              onClick={callNext}
              disabled={nextButtonDisabled || allCalled}
              className="w-full py-5 rounded-xl text-xl font-bold tracking-widest transition-all duration-200"
              style={{
                background: nextButtonDisabled || allCalled ? '#1a1a1a' : '#ef4444',
                color: nextButtonDisabled || allCalled ? '#444' : 'white',
                border: nextButtonDisabled || allCalled ? '1px solid #333' : '2px solid #ef4444',
                cursor: nextButtonDisabled || allCalled ? 'not-allowed' : 'pointer',
              }}
            >
              {allCalled ? 'GAME OVER' : '▶ NEXT'}
            </button>
 
            {allCalled && (
              <button onClick={endGame} className="w-full py-3 rounded-xl font-bold tracking-wider" style={{ background: '#fbbf24', color: '#000' }}>
                🏆 REVEAL RESULTS
              </button>
            )}
 
            {/* Notification */}
            {notification && (
              <div className="rounded-xl p-3 text-sm text-center animate-fade-in" style={{ background: '#1a1a2e', border: '1px solid #374151', color: '#e0e0e0' }}>
                {notification}
                {notification.includes('wants to leave') && (
                  <div className="flex gap-2 mt-2 justify-center">
                    <button onClick={() => handleLeaveDecision(students.find(s => notification.includes(s.name))?.id, true)} className="px-3 py-1 rounded text-xs" style={{ background: '#ef4444', color: 'white' }}>Approve</button>
                    <button onClick={() => handleLeaveDecision(students.find(s => notification.includes(s.name))?.id, false)} className="px-3 py-1 rounded text-xs" style={{ background: '#22c55e', color: 'white' }}>Deny</button>
                  </div>
                )}
              </div>
            )}
 
            {/* Defence countdown */}
            {defenceCountdown !== null && (
              <div className="rounded-xl p-4 text-center animate-flash-red" style={{ border: '2px solid #ef4444' }}>
                <p className="text-xs text-gray-400 tracking-widest mb-1">AWAITING DEFENCE DECISION</p>
                <p className="text-4xl font-bold text-red-500">{defenceCountdown}</p>
              </div>
            )}
          </div>
 
          {/* Right: Actions + Pick Next + Students */}
          <div className="col-span-1 flex flex-col gap-4">
            {/* Actions Box */}
            <div className="rounded-xl p-4" style={{ background: '#111', border: '1px solid #ef4444' }}>
              <p className="text-xs tracking-widest mb-3" style={{ color: '#ef4444' }}>ACTIONS BOX</p>
              {actionsBox.length === 0 && !activeAction && (
                <p className="text-gray-700 text-sm">No actions pending</p>
              )}
              {actionsBox.map((action, i) => (
                <div key={`${action.studentId}-${i}`}>
                  {!activeAction && (
                    <button
                      onClick={() => handleActionStudent(action)}
                      className="w-full text-left px-3 py-2 rounded-lg mb-2 text-sm font-bold transition-all hover:scale-105"
                      style={{ background: '#1a1a2e', border: '1px solid #374151', color: '#fbbf24' }}
                    >
                      {SYMBOLS[action.symbol]?.icon} {action.studentName} — {SYMBOLS[action.symbol]?.name}
                    </button>
                  )}
                  {activeAction?.studentId === action.studentId && !awaitingTarget && (
                    <div className="px-3 py-2 rounded-lg mb-2 text-sm" style={{ background: '#2a1a00', border: '1px solid #fbbf24' }}>
                      Processing: {action.studentName}...
                    </div>
                  )}
                </div>
              ))}
              {/* Target selection */}
              {awaitingTarget && activeAction && (
                <div>
                  <p className="text-xs text-gray-500 mb-2">Select target for {SYMBOLS[activeAction.symbol]?.name}:</p>
                  {activeStudents
                    .filter(s => s.id !== activeAction.studentId)
                    .map(s => (
                      <button
                        key={s.id}
                        onClick={() => handleSelectTarget(s)}
                        className="w-full text-left px-3 py-2 rounded-lg mb-1 text-sm transition-all hover:scale-105"
                        style={{ background: '#1a0a0a', border: '1px solid #ef4444', color: '#e0e0e0' }}
                      >
                        {s.name} — {formatDollars(s.points_in_play || 0)} in play
                      </button>
                    ))}
                </div>
              )}
            </div>
 
            {/* Pick Next Box */}
            {pickNextBox.length > 0 && (
              <div className="rounded-xl p-4" style={{ background: '#111', border: '1px solid #22c55e' }}>
                <p className="text-xs tracking-widest mb-3" style={{ color: '#22c55e' }}>PICK NEXT SQUARE</p>
                {pickNextBox.map((entry, i) => (
                  <div key={`${entry.studentId}-${i}`}>
                    {i === 0 && !activeTipOff ? (
                      <button
                        onClick={() => handleActivateTipOff(entry)}
                        className="w-full px-3 py-2 rounded-lg mb-2 text-sm font-bold transition-all hover:scale-105"
                        style={{ background: '#0a1a0a', border: '1px solid #22c55e', color: '#22c55e' }}
                      >
                        📻 {entry.studentName} — Click to activate
                      </button>
                    ) : (
                      <div className="px-3 py-2 rounded-lg mb-2 text-sm text-gray-500" style={{ background: '#111', border: '1px solid #374151' }}>
                        {i === 0 && activeTipOff ? `⏱ ${entry.studentName} — ${tipOffCountdown}s` : `${entry.studentName} — waiting`}
                      </div>
                    )}
                  </div>
                ))}
                {tipOffCountdown !== null && (
                  <div className="text-center">
                    <p className="text-3xl font-bold" style={{ color: '#22c55e' }}>{tipOffCountdown}</p>
                  </div>
                )}
              </div>
            )}
 
            {/* Student list with override */}
            <div className="rounded-xl p-4" style={{ background: '#111', border: '1px solid #333' }}>
              <p className="text-xs text-gray-600 tracking-widest mb-3">STUDENTS ({activeStudents.length})</p>
              <div className="max-h-48 overflow-y-auto">
                {activeStudents.map(s => (
                  <div key={s.id} className="flex items-center justify-between py-1 border-b border-gray-900">
                    <span className="text-sm text-gray-400">{s.name}</span>
                    <div className="flex items-center gap-2">
                      {s.bulletproof && <span className="text-xs">🦺</span>}
                      {s.frame_job && <span className="text-xs">🪞</span>}
                      <button
                        onClick={() => setScoreOverride({ show: true, studentId: s.id, value: s.points_in_play || 0 })}
                        className="text-xs text-gray-700 hover:text-gray-400"
                      >
                        ✏️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
 
      {/* Score Override Modal */}
      {scoreOverride.show && (
        <div className="popup-overlay">
          <div className="rounded-2xl p-6 w-80" style={{ background: '#111', border: '1px solid #fbbf24' }}>
            <h3 className="font-bold tracking-wider mb-4" style={{ color: '#fbbf24' }}>OVERRIDE SCORE</h3>
            <p className="text-sm text-gray-500 mb-4">{getStudentName(scoreOverride.studentId)}</p>
            <input
              type="number"
              value={scoreOverride.value}
              onChange={e => setScoreOverride(prev => ({ ...prev, value: e.target.value }))}
              className="w-full px-4 py-3 rounded-lg text-white mb-4 outline-none"
              style={{ background: '#1a1a2e', border: '1px solid #374151' }}
            />
            <div className="flex gap-3">
              <button onClick={handleScoreOverride} className="flex-1 py-2 rounded-lg font-bold" style={{ background: '#ef4444', color: 'white' }}>Apply</button>
              <button onClick={() => setScoreOverride({ show: false, studentId: null, value: '' })} className="flex-1 py-2 rounded-lg" style={{ background: '#333', color: 'white' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
 
// ============================================================
// LOBBY SCREEN
// ============================================================
function LobbyScreen({ gameCode, students, cuffedCount, canStart, onStart }) {
  return (
    <div className="max-w-2xl mx-auto">
      {/* Join code */}
      <div className="rounded-2xl p-8 text-center mb-6" style={{ background: '#111', border: '2px solid #ef4444' }}>
        <p className="text-sm text-gray-500 tracking-widest mb-2">JOIN CODE</p>
        <p className="text-7xl font-bold tracking-widest mb-4" style={{ color: '#fbbf24' }}>{gameCode}</p>
        <p className="text-gray-600 text-sm">Students go to the app and enter this code</p>
      </div>
 
      {/* Student list */}
      <div className="rounded-2xl p-6" style={{ background: '#111', border: '1px solid #333' }}>
        <div className="flex justify-between items-center mb-4">
          <p className="text-xs text-gray-600 tracking-widest">STUDENTS JOINED ({students.length})</p>
          <p className="text-xs tracking-widest" style={{ color: '#22c55e' }}>CUFFED IN: {cuffedCount}/{students.length}</p>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-6">
          {students.map(s => (
            <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: '#1a1a2e', border: `1px solid ${s.cuffed ? '#22c55e' : '#374151'}` }}>
              <span className="text-sm flex-1 truncate">{s.name}</span>
              <span>{s.cuffed ? '🔒' : '⏳'}</span>
            </div>
          ))}
          {students.length === 0 && (
            <div className="col-span-3 text-center text-gray-700 py-4">Waiting for students to join...</div>
          )}
        </div>
 
        <button
          onClick={onStart}
          disabled={!canStart}
          className="w-full py-4 rounded-xl text-lg font-bold tracking-widest transition-all"
          style={{
            background: canStart ? '#ef4444' : '#1a1a1a',
            color: canStart ? 'white' : '#444',
            border: canStart ? '2px solid #ef4444' : '1px solid #333',
            cursor: canStart ? 'pointer' : 'not-allowed',
          }}
        >
          {canStart ? '🚨 START GAME' : `WAITING FOR ALL STUDENTS TO CUFF IN (${cuffedCount}/${students.length})`}
        </button>
      </div>
    </div>
  )
}
 
// ============================================================
// TEACHER GRID
// ============================================================
function TeacherGrid({ calledRefs, currentRef }) {
  return (
    <div className="rounded-xl p-3" style={{ background: '#111', border: '1px solid #333' }}>
      <p className="text-xs text-gray-600 tracking-widest mb-3">GRID</p>
      {/* Column headers */}
      <div className="grid grid-cols-8 gap-1 mb-1">
        <div />
        {COLS.map(c => (
          <div key={c} className="text-center text-xs text-gray-600 font-bold">{c}</div>
        ))}
      </div>
      {/* Rows */}
      {ROWS.map(row => (
        <div key={row} className="grid grid-cols-8 gap-1 mb-1">
          <div className="text-xs text-gray-600 font-bold flex items-center justify-center">{row}</div>
          {COLS.map(col => {
            const ref = `${col}${row}`
            const called = calledRefs.includes(ref)
            const isCurrent = ref === currentRef
            return (
              <div
                key={ref}
                className="aspect-square rounded flex items-center justify-center text-xs font-bold transition-all"
                style={{
                  background: isCurrent ? '#fbbf24' : called ? '#1a1a1a' : '#1a1a2e',
                  color: isCurrent ? '#000' : called ? '#333' : '#666',
                  border: isCurrent ? '2px solid #fbbf24' : '1px solid #222',
                }}
              >
                {ref}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
 
// ============================================================
// PODIUM SCREEN
// ============================================================
function PodiumScreen({ scores }) {
  const [reveal, setReveal] = useState(0) // 0=none, 1=3rd, 2=2nd, 3=1st
 
  useEffect(() => {
    const t1 = setTimeout(() => setReveal(1), 1000)
    const t2 = setTimeout(() => setReveal(2), 3000)
    const t3 = setTimeout(() => setReveal(3), 5000)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])
 
  const third = scores[2]
  const second = scores[1]
  const first = scores[0]
 
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8" style={{ background: '#0a0a0f' }}>
      <h1 className="text-4xl font-bold tracking-widest mb-12" style={{ color: '#fbbf24' }}>
        {reveal >= 3 ? '🚨 FINAL RESULTS 🚨' : '🏆 PODIUM'}
      </h1>
 
      <div className="flex items-end gap-8 mb-12">
        {/* 3rd place */}
        <div className={`text-center transition-all duration-700 ${reveal >= 1 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {third && (
            <>
              <p className="text-4xl mb-2">🥉</p>
              <div className="rounded-xl px-6 py-4 w-40" style={{ background: '#1a1a2e', border: '2px solid #cd7f32' }}>
                <p className="font-bold text-lg truncate">{third.name}</p>
                <p className="text-sm" style={{ color: '#cd7f32' }}>{formatDollars(third.total)}</p>
              </div>
            </>
          )}
        </div>
 
        {/* 1st place */}
        <div className={`text-center transition-all duration-700 ${reveal >= 3 ? 'opacity-100 translate-y-0 animate-pulse-gold' : 'opacity-0 translate-y-10'}`}>
          {first && (
            <>
              <p className="text-6xl mb-2">🥇</p>
              <div className="rounded-xl px-8 py-6 w-48" style={{ background: '#1a1500', border: '3px solid #fbbf24', boxShadow: reveal >= 3 ? '0 0 30px #fbbf2466' : 'none' }}>
                <p className="font-bold text-2xl truncate" style={{ color: '#fbbf24' }}>{first.name}</p>
                <p className="text-lg" style={{ color: '#fbbf24' }}>{formatDollars(first.total)}</p>
              </div>
            </>
          )}
        </div>
 
        {/* 2nd place */}
        <div className={`text-center transition-all duration-700 ${reveal >= 2 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {second && (
            <>
              <p className="text-5xl mb-2">🥈</p>
              <div className="rounded-xl px-6 py-5 w-44" style={{ background: '#1a1a2e', border: '2px solid #9ca3af' }}>
                <p className="font-bold text-xl truncate">{second.name}</p>
                <p className="text-sm" style={{ color: '#9ca3af' }}>{formatDollars(second.total)}</p>
              </div>
            </>
          )}
        </div>
      </div>
 
      {reveal >= 3 && (
        <div className="w-full max-w-lg animate-fade-in">
          <p className="text-xs text-gray-600 tracking-widest text-center mb-4">FULL LEADERBOARD</p>
          {scores.map((s, i) => (
            <div key={s.id} className="flex justify-between items-center py-2 border-b border-gray-900">
              <div className="flex items-center gap-3">
                <span className="text-gray-600 w-6 text-sm">{i + 1}</span>
                <span className="text-sm">{s.name}</span>
              </div>
              <div className="flex gap-4 text-sm">
                <span className="text-gray-600">🏦 {formatDollars(s.banked)}</span>
                <span className="text-gray-500">+ {formatDollars(s.inPlay)}</span>
                <span className="font-bold" style={{ color: '#fbbf24' }}>{formatDollars(s.total)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
 
