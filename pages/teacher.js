import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { generateGameCode, COLS, ROWS, SYMBOLS, ACTION_SYMBOLS, formatDollars, shuffle, ALL_GRID_REFS } from '../lib/gameLogic'

const TIP_OFF_COUNTDOWN = 12
const DEFENCE_COUNTDOWN = 12

// Ordered list of symbols to show in the reference panel
const DESCRIPTOR_ORDER = ['HEIST', 'ARREST', 'INSIDE_JOB', 'SWITCHEROO', 'TIP_OFF', 'BULLETPROOF', 'FRAME_JOB', 'CRIME_SPREE', 'VAULT']

export default function Teacher() {
  const [authed, setAuthed] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [phase, setPhase] = useState('lobby')
  const [gameCode, setGameCode] = useState('')
  const [gameId, setGameId] = useState(null)
  const [students, setStudents] = useState([])
  const [calledRefs, setCalledRefs] = useState([])
  const [callOrder, setCallOrder] = useState([])
  const [currentRef, setCurrentRef] = useState(null)
  const [actionsBox, setActionsBox] = useState([])
  const [pickNextBox, setPickNextBox] = useState([])
  const [activeAction, setActiveAction] = useState(null)
  const [awaitingTarget, setAwaitingTarget] = useState(false)
  const [defenceCountdown, setDefenceCountdown] = useState(null)
  const [tipOffCountdown, setTipOffCountdown] = useState(null)
  const [activeTipOff, setActiveTipOff] = useState(null)
  const [notification, setNotification] = useState('')
  const [podiumData, setPodiumData] = useState(null)
  const [scoreOverride, setScoreOverride] = useState({ show: false, studentId: null, value: '' })

  const defenceTimerRef = useRef(null)
  const tipOffTimerRef = useRef(null)
  const gameIdRef = useRef(null)
  const calledRefsRef = useRef([])
  const callOrderRef = useRef([])
  const studentsRef = useRef([])
  const activeActionRef = useRef(null)
  const pickNextBoxRef = useRef([])
  const activeTipOffRef = useRef(null)
  const phaseRef = useRef('lobby')

  const handleLogin = () => {
    if (username === 'admin@admin' && password === 'admin') {
      setAuthed(true)
      initGame()
    } else {
      setAuthError('Invalid username or password')
    }
  }

  const initGame = async () => {
    const code = generateGameCode()
    const order = shuffle([...ALL_GRID_REFS])
    setGameCode(code)
    setCallOrder(order)
    callOrderRef.current = order

    const { data, error } = await supabase.from('games').insert({
      code,
      phase: 'lobby',
      call_order: order,
      called_refs: [],
      current_ref: null,
    }).select().single()

    if (error) { console.error(error); return }
    setGameId(data.id)
    gameIdRef.current = data.id
    subscribeToStudents(data.id)
  }

  const subscribeToStudents = (gid) => {
    supabase.channel(`students-teacher-${gid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students', filter: `game_id=eq.${gid}` }, async (payload) => {
        const { data } = await supabase.from('students').select('*').eq('game_id', gid).order('name')
        if (data) {
          setStudents(data)
          studentsRef.current = data
        }
        if (payload.new) {
          const s = payload.new
          if (s.defence_response !== null && s.defence_response !== undefined && activeActionRef.current) {
            handleDefenceResponse(s.defence_response, s.id)
          }
          if (s.tip_off_pick && activeTipOffRef.current && activeTipOffRef.current.studentId === s.id) {
            handleTipOffPick(s.tip_off_pick, s.id)
          }
          if (s.leaving === true) {
            setNotification(`⚠️ ${s.name} wants to leave the game`)
          }
        }
      })
      .subscribe()
  }

  const reloadStudents = async () => {
    const { data } = await supabase.from('students').select('*').eq('game_id', gameIdRef.current).order('name')
    if (data) {
      setStudents(data)
      studentsRef.current = data
    }
    return data || []
  }

  const getStudentName = (id) => {
    const s = studentsRef.current.find(s => s.id === id)
    return s ? s.name : 'Unknown'
  }

  const startGame = async () => {
    await supabase.from('games').update({ phase: 'playing' }).eq('id', gameIdRef.current)
    await supabase.from('students').update({ phase: 'playing' }).eq('game_id', gameIdRef.current)
    setPhase('playing')
    phaseRef.current = 'playing'
  }

  const callNext = async () => {
    if (actionsBox.length > 0 || pickNextBoxRef.current.length > 0 || phaseRef.current === 'paused') return
    const currentCalled = calledRefsRef.current
    const order = callOrderRef.current
    const nextRef = order.find(r => !currentCalled.includes(r))
    if (!nextRef) { endGame(); return }
    await callRef(nextRef)
  }

  const callRef = async (ref) => {
    const currentCalled = calledRefsRef.current
    if (currentCalled.includes(ref)) return
    const newCalled = [...currentCalled, ref]
    setCalledRefs(newCalled)
    calledRefsRef.current = newCalled
    setCurrentRef(ref)
    await supabase.from('games').update({ current_ref: ref, called_refs: newCalled }).eq('id', gameIdRef.current)
    await processRef(ref)
  }

  const processRef = async (ref) => {
    const col = ref[0]
    const row = parseInt(ref[1])
    const colIdx = COLS.indexOf(col)
    const rowIdx = row - 1
    const cellIdx = colIdx * 7 + rowIdx
    const freshStudents = await reloadStudents()
    const newActions = []
    const newPickNext = []

    for (const student of freshStudents) {
      if (!student.grid || student.active === false) continue
      const cell = student.grid[cellIdx]
      if (!cell) continue

      if (cell.type === 'points') {
        const newPoints = (student.points_in_play || 0) + cell.value
        await supabase.from('students').update({ points_in_play: newPoints }).eq('id', student.id)
      } else if (cell.type === 'symbol') {
        const sym = cell.value
        if (sym === 'VAULT') {
          const newBank = (student.points_banked || 0) + (student.points_in_play || 0)
          await supabase.from('students').update({ points_banked: newBank, points_in_play: 0 }).eq('id', student.id)
          await notifyStudent(student.id, { type: 'VAULT', message: '🏦 Your points have been banked!' })
        } else if (sym === 'CRIME_SPREE') {
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

    newActions.sort((a, b) => a.studentName.localeCompare(b.studentName))
    if (newActions.length > 0) setActionsBox(prev => [...prev, ...newActions])
    if (newPickNext.length > 0) {
      setPickNextBox(prev => {
        const updated = [...prev, ...newPickNext]
        pickNextBoxRef.current = updated
        return updated
      })
    }
    await reloadStudents()
  }

  const notifyStudent = async (studentId, notif) => {
    await supabase.from('students').update({ notification: notif }).eq('id', studentId)
  }

  const handleActionStudent = (action) => {
    setActiveAction(action)
    activeActionRef.current = action
    setAwaitingTarget(true)
  }

  const handleSelectTarget = async (targetStudent) => {
    if (!activeActionRef.current) return
    const action = activeActionRef.current
    const isAttack = ['HEIST', 'ARREST', 'SWITCHEROO'].includes(action.symbol)
    const hasDefence = isAttack && (targetStudent.bulletproof || targetStudent.frame_job)

    if (hasDefence) {
      await notifyStudent(targetStudent.id, {
        type: 'DEFENCE_PROMPT',
        message: 'Do you want to use your defence?',
        attackSymbol: action.symbol,
        attackerName: getStudentName(action.studentId),
        hasBulletproof: targetStudent.bulletproof,
        hasFrameJob: targetStudent.frame_job,
      })
      setAwaitingTarget(false)
      startDefenceCountdown(targetStudent.id)
    } else {
      setAwaitingTarget(false)
      await executeAction(action.studentId, targetStudent.id, action.symbol, false)
    }
  }

  const startDefenceCountdown = (targetId) => {
    if (defenceTimerRef.current) clearInterval(defenceTimerRef.current)
    let count = DEFENCE_COUNTDOWN
    setDefenceCountdown(count)
    defenceTimerRef.current = setInterval(() => {
      count--
      setDefenceCountdown(count)
      if (count <= 0) {
        clearInterval(defenceTimerRef.current)
        setDefenceCountdown(null)
        const action = activeActionRef.current
        if (action) executeAction(action.studentId, targetId, action.symbol, false)
      }
    }, 1000)
  }

  const handleDefenceResponse = async (response, responderId) => {
    if (defenceTimerRef.current) clearInterval(defenceTimerRef.current)
    setDefenceCountdown(null)

    const action = activeActionRef.current
    if (!action) return

    const used = response.used
    const type = response.type

    await supabase.from('students').update({ defence_response: null }).eq('id', responderId)

    if (!used) {
      await executeAction(action.studentId, responderId, action.symbol, false)
    } else if (type === 'BULLETPROOF') {
      setNotification(`🦺 ${getStudentName(responderId)} used Bulletproof — attack blocked!`)
      await supabase.from('students').update({ bulletproof: false }).eq('id', responderId)
      await reloadStudents()
      finishAction()
    } else if (type === 'FRAME_JOB') {
      setNotification(`🪞 ${getStudentName(responderId)} used Frame Job — attack reversed!`)
      await supabase.from('students').update({ frame_job: false }).eq('id', responderId)
      await executeAction(responderId, action.studentId, action.symbol, true)
    }
  }

  const executeAction = async (attackerId, targetId, symbol, reversed) => {
    const freshStudents = await reloadStudents()
    const attacker = freshStudents.find(s => s.id === attackerId)
    const target = freshStudents.find(s => s.id === targetId)
    if (!attacker || !target) { finishAction(); return }

    if (symbol === 'HEIST') {
      const stolen = target.points_in_play || 0
      if (reversed) {
        await supabase.from('students').update({ points_in_play: (target.points_in_play || 0) + (attacker.points_in_play || 0) }).eq('id', targetId)
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', attackerId)
        setNotification(`🪞 Frame Job! ${target.name} robbed ${attacker.name} instead!`)
      } else {
        await supabase.from('students').update({ points_in_play: (attacker.points_in_play || 0) + stolen }).eq('id', attackerId)
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', targetId)
        setNotification(`💰 ${attacker.name} robbed ${target.name}!`)
        await notifyStudent(targetId, { type: 'HEIST', message: `💰 You've been robbed by ${attacker.name}!` })
      }
    } else if (symbol === 'ARREST') {
      if (reversed) {
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', attackerId)
        setNotification(`🪞 Arrest Warrant turned on ${attacker.name}!`)
        await notifyStudent(attackerId, { type: 'ARREST', message: `📜 Your Arrest Warrant backfired!` })
      } else {
        await supabase.from('students').update({ points_in_play: 0 }).eq('id', targetId)
        setNotification(`📜 ${attacker.name} arrested ${target.name}!`)
        await notifyStudent(targetId, { type: 'ARREST', message: `📜 Arrest Warrant! Points wiped!` })
      }
    } else if (symbol === 'SWITCHEROO') {
      if (reversed) {
        setNotification(`🪞 Switcheroo blocked by Frame Job!`)
      } else {
        const aPoints = attacker.points_in_play || 0
        const tPoints = target.points_in_play || 0
        await supabase.from('students').update({ points_in_play: tPoints }).eq('id', attackerId)
        await supabase.from('students').update({ points_in_play: aPoints }).eq('id', targetId)
        setNotification(`🔄 ${attacker.name} switched points with ${target.name}!`)
        await notifyStudent(targetId, { type: 'SWITCHEROO', message: `🔄 ${attacker.name} switched points with you!` })
      }
    } else if (symbol === 'INSIDE_JOB') {
      await supabase.from('students').update({ points_in_play: (target.points_in_play || 0) + 1000 }).eq('id', targetId)
      setNotification(`🤝 ${attacker.name} gave $1,000 to ${target.name}!`)
      await notifyStudent(targetId, { type: 'INSIDE_JOB', message: `🤝 ${attacker.name} gave you $1,000!` })
    }

    await reloadStudents()
    finishAction()
  }

  const finishAction = () => {
    const current = activeActionRef.current
    if (!current) return
    setActionsBox(prev => prev.filter(a => a.studentId !== current.studentId))
    setActiveAction(null)
    activeActionRef.current = null
    setAwaitingTarget(false)
    setDefenceCountdown(null)
  }

  const handleActivateTipOff = async (entry) => {
    setActiveTipOff(entry)
    activeTipOffRef.current = entry
    await notifyStudent(entry.studentId, { type: 'TIP_OFF_ACTIVATE', message: '📻 Pick your square! You have 12 seconds!' })
    if (tipOffTimerRef.current) clearInterval(tipOffTimerRef.current)
    let count = TIP_OFF_COUNTDOWN
    setTipOffCountdown(count)
    tipOffTimerRef.current = setInterval(() => {
      count--
      setTipOffCountdown(count)
      if (count <= 0) {
        clearInterval(tipOffTimerRef.current)
        setTipOffCountdown(null)
        const available = callOrderRef.current.filter(r => !calledRefsRef.current.includes(r))
        if (available.length > 0) {
          const randomRef = available[Math.floor(Math.random() * available.length)]
          processTipOffPick(randomRef, entry.studentId, true)
        }
      }
    }, 1000)
  }

  const handleTipOffPick = (ref, studentId) => {
    if (tipOffTimerRef.current) clearInterval(tipOffTimerRef.current)
    setTipOffCountdown(null)
    processTipOffPick(ref, studentId, false)
  }

  const processTipOffPick = async (ref, studentId, wasRandom) => {
    setNotification(wasRandom ? `⏱️ Time up! Random square ${ref} selected` : `📻 ${getStudentName(studentId)} picked square ${ref}!`)
    await supabase.from('students').update({ tip_off_pick: null }).eq('id', studentId)
    setPickNextBox(prev => {
      const updated = prev.filter(p => p.studentId !== studentId)
      pickNextBoxRef.current = updated
      return updated
    })
    setActiveTipOff(null)
    activeTipOffRef.current = null
    await callRef(ref)
  }

  const togglePause = async () => {
    const newPhase = phaseRef.current === 'paused' ? 'playing' : 'paused'
    setPhase(newPhase)
    phaseRef.current = newPhase
    await supabase.from('games').update({ phase: newPhase }).eq('id', gameIdRef.current)
    await supabase.from('students').update({ phase: newPhase }).eq('game_id', gameIdRef.current)
  }

  const endGame = async () => {
    const data = await reloadStudents()
    const finalScores = data.map(s => ({
      id: s.id, name: s.name,
      total: (s.points_banked || 0) + (s.points_in_play || 0),
      banked: s.points_banked || 0,
      inPlay: s.points_in_play || 0,
    })).sort((a, b) => b.total - a.total)
    setPodiumData(finalScores)
    setPhase('ended')
    await supabase.from('games').update({ phase: 'ended', final_scores: finalScores }).eq('id', gameIdRef.current)
    await supabase.from('students').update({ phase: 'ended' }).eq('game_id', gameIdRef.current)
  }

  const handleScoreOverride = async () => {
    const val = parseInt(scoreOverride.value)
    if (isNaN(val)) return
    await supabase.from('students').update({ points_in_play: val }).eq('id', scoreOverride.studentId)
    await reloadStudents()
    setScoreOverride({ show: false, studentId: null, value: '' })
  }

  const handleLeaveDecision = async (studentId, approve) => {
    if (approve) {
      await supabase.from('students').update({ active: false, leaving: false }).eq('id', studentId)
    } else {
      await supabase.from('students').update({ leaving: false }).eq('id', studentId)
      await notifyStudent(studentId, { type: 'LEAVE_DENIED', message: '🚫 Your teacher says stay in the game!' })
    }
    setNotification('')
    await reloadStudents()
  }

  const activeStudents = students.filter(s => s.active !== false)
  const cuffedCount = activeStudents.filter(s => s.cuffed).length
  const canStart = cuffedCount > 0 && cuffedCount === activeStudents.length
  const nextButtonDisabled = actionsBox.length > 0 || pickNextBoxRef.current.length > 0 || phase === 'paused'
  const allCalled = calledRefs.length >= 49

  // Determine which symbol is currently "lit up" — the one being actioned right now
  const litSymbol = activeAction ? activeAction.symbol : null

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6" style={{ background: '#0a0a0f' }}>
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="text-4xl mb-3">👮</div>
            <h1 className="text-3xl font-bold tracking-widest" style={{ color: '#ef4444' }}>TEACHER LOGIN</h1>
            <p className="text-gray-600 text-xs tracking-widest mt-1">COPS & ROBBERS</p>
          </div>
          <div className="rounded-2xl p-6" style={{ background: '#111', border: '1px solid #333' }}>
            <div className="mb-4">
              <label className="block text-xs tracking-widest text-gray-500 mb-2">EMAIL</label>
              <input type="email" value={username} onChange={e => setUsername(e.target.value)} placeholder="admin@admin"
                className="w-full px-4 py-3 rounded-lg text-white placeholder-gray-600 outline-none"
                style={{ background: '#1a1a2e', border: '1px solid #374151' }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
            <div className="mb-6">
              <label className="block text-xs tracking-widest text-gray-500 mb-2">PASSWORD</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••"
                className="w-full px-4 py-3 rounded-lg text-white placeholder-gray-600 outline-none"
                style={{ background: '#1a1a2e', border: '1px solid #374151' }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            </div>
            {authError && <p className="text-red-400 text-sm text-center mb-4">{authError}</p>}
            <button onClick={handleLogin} className="w-full py-3 rounded-xl font-bold tracking-widest" style={{ background: '#ef4444', color: 'white' }}>
              LOGIN 🚨
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'ended' && podiumData) return <PodiumScreen scores={podiumData} />

  if (phase === 'lobby') {
    return (
      <div className="min-h-screen p-6" style={{ background: '#0a0a0f' }}>
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-bold tracking-widest mb-6 text-center" style={{ color: '#ef4444' }}>COPS & ROBBERS</h1>
          <div className="rounded-2xl p-8 text-center mb-6" style={{ background: '#111', border: '2px solid #ef4444' }}>
            <p className="text-sm text-gray-500 tracking-widest mb-2">JOIN CODE</p>
            <p className="text-7xl font-bold tracking-widest mb-4" style={{ color: '#fbbf24' }}>{gameCode}</p>
            <p className="text-gray-600 text-sm">Students go to the app and enter this code</p>
          </div>
          <div className="rounded-2xl p-6" style={{ background: '#111', border: '1px solid #333' }}>
            <div className="flex justify-between items-center mb-4">
              <p className="text-xs text-gray-600 tracking-widest">STUDENTS JOINED ({activeStudents.length})</p>
              <p className="text-xs tracking-widest" style={{ color: '#22c55e' }}>CUFFED IN: {cuffedCount}/{activeStudents.length}</p>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-6">
              {activeStudents.map(s => (
                <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: '#1a1a2e', border: `1px solid ${s.cuffed ? '#22c55e' : '#374151'}` }}>
                  <span className="text-sm flex-1 truncate">{s.name}</span>
                  <span>{s.cuffed ? '🔒' : '⏳'}</span>
                </div>
              ))}
              {activeStudents.length === 0 && <div className="col-span-3 text-center text-gray-700 py-4">Waiting for students to join...</div>}
            </div>
            <button onClick={startGame} disabled={!canStart} className="w-full py-4 rounded-xl text-lg font-bold tracking-widest"
              style={{ background: canStart ? '#ef4444' : '#1a1a1a', color: canStart ? 'white' : '#444', border: canStart ? '2px solid #ef4444' : '1px solid #333', cursor: canStart ? 'pointer' : 'not-allowed' }}>
              {canStart ? '🚨 START GAME' : `WAITING FOR ALL STUDENTS TO CUFF IN (${cuffedCount}/${activeStudents.length})`}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-3" style={{ background: '#0a0a0f' }}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-xl font-bold tracking-widest" style={{ color: '#ef4444' }}>COPS & ROBBERS</h1>
          <p className="text-xs text-gray-600 tracking-widest">TEACHER CONTROL</p>
        </div>
        <div className="flex items-center gap-3">
          {phase === 'playing' && <button onClick={togglePause} className="px-3 py-1 rounded-lg text-xs font-bold" style={{ background: '#1a1a2e', border: '1px solid #fbbf24', color: '#fbbf24' }}>⏸ PAUSE</button>}
          {phase === 'paused' && <button onClick={togglePause} className="px-3 py-1 rounded-lg text-xs font-bold" style={{ background: '#1a1a2e', border: '1px solid #22c55e', color: '#22c55e' }}>▶ RESUME</button>}
          <div className="text-right">
            <p className="text-xs text-gray-600">SQUARES</p>
            <p className="text-lg font-bold" style={{ color: '#fbbf24' }}>{calledRefs.length}/49</p>
          </div>
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: '2fr 1fr 1fr' }}>
        {/* BIG GRID + DESCRIPTOR PANEL BELOW IT */}
        <div className="flex flex-col gap-2">
          <div className="rounded-xl p-2" style={{ background: '#111', border: '1px solid #333' }}>
            <p className="text-xs text-gray-600 tracking-widest mb-1">GRID</p>
            <div className="grid grid-cols-8" style={{ gap: '2px', marginBottom: '2px' }}>
              <div />
              {COLS.map(c => <div key={c} className="text-center text-gray-500 font-bold" style={{ fontSize: '9px' }}>{c}</div>)}
            </div>
            {ROWS.map(row => (
              <div key={row} className="grid grid-cols-8" style={{ gap: '2px', marginBottom: '2px' }}>
                <div className="text-gray-500 font-bold flex items-center justify-center" style={{ fontSize: '9px' }}>{row}</div>
                {COLS.map(col => {
                  const ref = `${col}${row}`
                  const called = calledRefs.includes(ref)
                  const isCurrent = ref === currentRef
                  return (
                    <div key={ref} className="rounded flex items-center justify-center font-bold transition-all"
                      style={{ aspectRatio: '1', background: isCurrent ? '#fbbf24' : called ? '#1a1a1a' : '#1a1a2e', color: isCurrent ? '#000' : called ? '#333' : '#666', border: isCurrent ? '2px solid #fbbf24' : '1px solid #222', fontSize: '8px' }}>
                      {ref}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* DESCRIPTOR REFERENCE PANEL */}
          <div className="rounded-xl p-3" style={{ background: '#111', border: '1px solid #333' }}>
            <p className="text-xs text-gray-600 tracking-widest mb-2">SYMBOL GUIDE</p>
            <div className="grid grid-cols-3 gap-2">
              {DESCRIPTOR_ORDER.map(symId => {
                const sym = SYMBOLS[symId]
                const isLit = litSymbol === symId
                return (
                  <div key={symId}
                    className="rounded-lg px-2 py-2 transition-all duration-300"
                    style={{
                      background: isLit ? '#2a1a00' : '#1a1a2e',
                      border: isLit ? '2px solid #fbbf24' : '1px solid #333',
                      boxShadow: isLit ? '0 0 16px #fbbf2466' : 'none',
                    }}>
                    <p className="flex items-center gap-1" style={{ fontSize: '11px', fontWeight: isLit ? 800 : 600, color: isLit ? '#fbbf24' : '#9ca3af' }}>
                      <span style={{ fontSize: '14px' }}>{sym.icon}</span> {sym.name}
                    </p>
                    <p style={{ fontSize: '10px', color: isLit ? '#fde68a' : '#555', marginTop: '2px' }}>{sym.description}</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* CONTROLS */}
        <div className="flex flex-col gap-3">
          <div className="rounded-xl p-4 text-center" style={{ background: '#111', border: '1px solid #333' }}>
            <p className="text-xs text-gray-600 tracking-widest mb-1">CURRENT SQUARE</p>
            <p className="text-5xl font-bold" style={{ color: '#fbbf24' }}>{currentRef || '—'}</p>
          </div>
          <button onClick={callNext} disabled={nextButtonDisabled || allCalled} className="w-full py-4 rounded-xl text-xl font-bold tracking-widest"
            style={{ background: nextButtonDisabled || allCalled ? '#1a1a1a' : '#ef4444', color: nextButtonDisabled || allCalled ? '#444' : 'white', border: nextButtonDisabled || allCalled ? '1px solid #333' : '2px solid #ef4444', cursor: nextButtonDisabled || allCalled ? 'not-allowed' : 'pointer' }}>
            {allCalled ? 'ALL DONE' : '▶ NEXT'}
          </button>
          {allCalled && <button onClick={endGame} className="w-full py-3 rounded-xl font-bold" style={{ background: '#fbbf24', color: '#000' }}>🏆 REVEAL RESULTS</button>}
          {defenceCountdown !== null && (
            <div className="rounded-xl p-3 text-center" style={{ border: '2px solid #ef4444', background: '#1a0000' }}>
              <p className="text-xs text-gray-400 mb-1">DEFENCE DECISION</p>
              <p className="text-4xl font-bold text-red-500">{defenceCountdown}</p>
            </div>
          )}
          {notification && (
            <div className="rounded-xl p-3 text-sm text-center" style={{ background: '#1a1a2e', border: '1px solid #374151', color: '#e0e0e0' }}>
              {notification}
              {notification.includes('wants to leave') && (
                <div className="flex gap-2 mt-2 justify-center">
                  <button onClick={() => handleLeaveDecision(activeStudents.find(s => notification.includes(s.name))?.id, true)} className="px-3 py-1 rounded text-xs" style={{ background: '#ef4444', color: 'white' }}>Approve</button>
                  <button onClick={() => handleLeaveDecision(activeStudents.find(s => notification.includes(s.name))?.id, false)} className="px-3 py-1 rounded text-xs" style={{ background: '#22c55e', color: 'white' }}>Deny</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ACTIONS + PICK NEXT + STUDENTS */}
        <div className="flex flex-col gap-3">
          <div className="rounded-xl p-3" style={{ background: '#111', border: '1px solid #ef4444' }}>
            <p className="text-xs tracking-widest mb-2" style={{ color: '#ef4444' }}>ACTIONS BOX</p>
            {actionsBox.length === 0 && !activeAction && <p className="text-gray-700 text-xs">No actions pending</p>}
            {actionsBox.map((action, i) => (
              !activeAction && (
                <button key={`${action.studentId}-${i}`} onClick={() => handleActionStudent(action)}
                  className="w-full text-left px-3 py-2 rounded-lg mb-1 text-sm font-bold"
                  style={{ background: '#1a1a2e', border: '1px solid #374151', color: '#fbbf24' }}>
                  {SYMBOLS[action.symbol]?.icon} {action.studentName} — {SYMBOLS[action.symbol]?.name}
                </button>
              )
            ))}
            {awaitingTarget && activeAction && (
              <div>
                <p className="text-xs text-gray-500 mb-2">Select target for {SYMBOLS[activeAction.symbol]?.name}:</p>
                {activeStudents.filter(s => s.id !== activeAction.studentId).map(s => (
                  <button key={s.id} onClick={() => handleSelectTarget(s)}
                    className="w-full text-left px-3 py-2 rounded-lg mb-1 text-sm"
                    style={{ background: '#1a0a0a', border: '1px solid #ef4444', color: '#e0e0e0' }}>
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {pickNextBox.length > 0 && (
            <div className="rounded-xl p-3" style={{ background: '#111', border: '1px solid #22c55e' }}>
              <p className="text-xs tracking-widest mb-2" style={{ color: '#22c55e' }}>PICK NEXT SQUARE</p>
              {pickNextBox.map((entry, i) => (
                <div key={`${entry.studentId}-${i}`}>
                  {i === 0 && !activeTipOff ? (
                    <button onClick={() => handleActivateTipOff(entry)} className="w-full px-3 py-2 rounded-lg mb-1 text-sm font-bold"
                      style={{ background: '#0a1a0a', border: '1px solid #22c55e', color: '#22c55e' }}>
                      📻 {entry.studentName} — Click to activate
                    </button>
                  ) : (
                    <div className="px-3 py-2 rounded-lg mb-1 text-sm text-gray-600" style={{ background: '#111', border: '1px solid #333' }}>
                      {i === 0 && activeTipOff ? `⏱ ${entry.studentName} — ${tipOffCountdown}s` : `${entry.studentName} — waiting`}
                    </div>
                  )}
                </div>
              ))}
              {tipOffCountdown !== null && <p className="text-2xl font-bold text-center mt-1" style={{ color: '#22c55e' }}>{tipOffCountdown}</p>}
            </div>
          )}

          <div className="rounded-xl p-3" style={{ background: '#111', border: '1px solid #333' }}>
            <p className="text-xs text-gray-600 tracking-widest mb-2">STUDENTS ({activeStudents.length})</p>
            <div className="max-h-40 overflow-y-auto">
              {activeStudents.map(s => (
                <div key={s.id} className="flex items-center justify-between py-1 border-b border-gray-900">
                  <span className="text-xs text-gray-400">{s.name}</span>
                  <button onClick={() => setScoreOverride({ show: true, studentId: s.id, value: s.points_in_play || 0 })} className="text-xs text-gray-700 hover:text-gray-400">✏️</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {scoreOverride.show && (
        <div className="popup-overlay">
          <div className="rounded-2xl p-6 w-80" style={{ background: '#111', border: '1px solid #fbbf24' }}>
            <h3 className="font-bold tracking-wider mb-4" style={{ color: '#fbbf24' }}>OVERRIDE SCORE</h3>
            <p className="text-sm text-gray-500 mb-4">{getStudentName(scoreOverride.studentId)} — points in play</p>
            <input type="number" value={scoreOverride.value} onChange={e => setScoreOverride(prev => ({ ...prev, value: e.target.value }))}
              className="w-full px-4 py-3 rounded-lg text-white mb-4 outline-none" style={{ background: '#1a1a2e', border: '1px solid #374151' }} />
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

function PodiumScreen({ scores }) {
  const [reveal, setReveal] = useState(0)
  useEffect(() => {
    const t1 = setTimeout(() => setReveal(1), 2000)
    const t2 = setTimeout(() => setReveal(2), 5000)
    const t3 = setTimeout(() => setReveal(3), 9000)
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
        <div className={`text-center transition-all duration-1000 ${reveal >= 1 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {third && <>
            <p className="text-4xl mb-2">🥉</p>
            <div className="rounded-xl px-6 py-4 w-40" style={{ background: '#1a1a2e', border: '2px solid #cd7f32' }}>
              <p className="font-bold text-lg truncate">{third.name}</p>
              <p className="text-sm" style={{ color: '#cd7f32' }}>{formatDollars(third.total)}</p>
            </div>
          </>}
        </div>
        <div className={`text-center transition-all duration-1000 ${reveal >= 3 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {first && <>
            <p className="text-6xl mb-2">🥇</p>
            <div className="rounded-xl px-8 py-6 w-48" style={{ background: '#1a1500', border: '3px solid #fbbf24', boxShadow: reveal >= 3 ? '0 0 30px #fbbf2466' : 'none' }}>
              <p className="font-bold text-2xl truncate" style={{ color: '#fbbf24' }}>{first.name}</p>
              <p className="text-lg" style={{ color: '#fbbf24' }}>{formatDollars(first.total)}</p>
            </div>
          </>}
        </div>
        <div className={`text-center transition-all duration-1000 ${reveal >= 2 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
          {second && <>
            <p className="text-5xl mb-2">🥈</p>
            <div className="rounded-xl px-6 py-5 w-44" style={{ background: '#1a1a2e', border: '2px solid #9ca3af' }}>
              <p className="font-bold text-xl truncate">{second.name}</p>
              <p className="text-sm" style={{ color: '#9ca3af' }}>{formatDollars(second.total)}</p>
            </div>
          </>}
        </div>
      </div>
      {reveal >= 3 && (
        <div className="w-full max-w-lg animate-fade-in">
          <p className="text-xs text-gray-600 tracking-widest text-center mb-4">FULL RESULTS</p>
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
