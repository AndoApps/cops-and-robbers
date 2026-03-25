-- ============================================================
-- COPS AND ROBBERS - Supabase Database Setup
-- Run this entire script in the Supabase SQL Editor
-- ============================================================

-- Games table
CREATE TABLE IF NOT EXISTS games (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  code TEXT NOT NULL UNIQUE,
  phase TEXT DEFAULT 'lobby',
  call_order JSONB DEFAULT '[]',
  called_refs JSONB DEFAULT '[]',
  current_ref TEXT,
  actions_box JSONB DEFAULT '[]',
  pick_next_box JSONB DEFAULT '[]',
  current_action JSONB,
  final_scores JSONB
);

-- Students table
CREATE TABLE IF NOT EXISTS students (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phase TEXT DEFAULT 'setup',
  points_in_play INTEGER DEFAULT 0,
  points_banked INTEGER DEFAULT 0,
  bulletproof BOOLEAN DEFAULT FALSE,
  frame_job BOOLEAN DEFAULT FALSE,
  cuffed BOOLEAN DEFAULT FALSE,
  active BOOLEAN DEFAULT TRUE,
  leaving BOOLEAN DEFAULT FALSE,
  grid JSONB,
  notification JSONB,
  defence_response JSONB,
  tip_off_pick TEXT
);

-- Enable Row Level Security
ALTER TABLE games ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;

-- RLS Policies for games (allow all for now - fine for classroom use)
CREATE POLICY "Allow all on games" ON games FOR ALL USING (true) WITH CHECK (true);

-- RLS Policies for students
CREATE POLICY "Allow all on students" ON students FOR ALL USING (true) WITH CHECK (true);

-- Enable Realtime for both tables
ALTER PUBLICATION supabase_realtime ADD TABLE games;
ALTER PUBLICATION supabase_realtime ADD TABLE students;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_games_code ON games(code);
CREATE INDEX IF NOT EXISTS idx_students_game_id ON students(game_id);
