import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown,
  ChevronLeft, ChevronRight, CircleAlert, Clock3, FileSpreadsheet, Filter, LayoutDashboard,
  LogOut, Menu, Plus, Search, Settings2, ShieldCheck, Stethoscope, Users, X,
} from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey, getGetMonthlyScheduleQueryKey, getGetMyScheduleQueryKey,
  getGetRecentActivityQueryKey,
  getGetRosterVersionScheduleQueryKey,
  getListDepartmentsQueryKey, getListEmployeesQueryKey, getListRosterImportsQueryKey,
  getListRosterVersionsQueryKey, getListShiftTypesQueryKey,
  useCreateDepartment, useCreateEmployee, useCreateRosterAssignment, useCreateShiftType,
  useCreateRosterVersion,
  useConfirmRosterImport, useDeleteRosterAssignment, useGetCurrentUser, useGetDashboardSummary,
  useGetMonthlySchedule, useGetMySchedule, useGetRecentActivity, useHealthCheck, useListDepartments,
  useGetRosterVersionSchedule,
  useListEmployees, useListRosterImports, useListRosterVersions, useListShiftTypes,
  usePreviewRosterImport, usePublishRosterVersion, useResolveRosterImport, useRollbackRosterVersion,
  useUpdateDepartment, useUpdateEmployee, useUpdateRosterAssignment, useUpdateShiftType,
  type ActivityItem, type Department, type Employee, type ImportMapping, type ImportPreview,
  type RosterVersion, type ShiftAssignment, type ShiftType,
} from '@workspace/api-client-react';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const monthNow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const dateQatar = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const fmtDate = (date: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }) =>
  new Intl.DateTimeFormat('en', { ...options, timeZone: 'Asia/Qatar' }).format(new Date(`${date}T12:00:00+03:00`));
const fmtTime = (iso?: string | null) => iso ? iso.slice(0, 5) : '';
const monthLabel = (month: string) => new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'Asia/Qatar' }).format(new Date(`${month}-01T12:00:00+03:00`));
const invalidate = (keys: readonly unknown[]) => queryClient.invalidateQueries({ queryKey: keys });
const invalidateRosterReads = () => {
  invalidate(getGetMonthlyScheduleQueryKey());
  invalidate(getGetMyScheduleQueryKey());
  invalidate(getGetDashboardSummaryQueryKey());
  invalidate(getListRosterVersionsQueryKey());
  invalidate(getGetRecentActivityQueryKey());
};

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const appearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#176f88', colorForeground: '#233342', colorMutedForeground: '#687984',
    colorDanger: '#bd534b', colorBackground: '#fffefa', colorInput: '#f5f7f5',
    colorInputForeground: '#233342', colorNeutral: '#233342', fontFamily: 'DM Sans',
    borderRadius: '12px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fffefa] rounded-2xl w-[440px] max-w-full shadow-xl overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent',
    footer: '!shadow-none !border-0 !bg-transparent',
    headerTitle: 'text-[#233342] font-semibold', headerSubtitle: 'text-[#687984]',
    socialButtonsBlockButtonText: 'text-[#233342]', formFieldLabel: 'text-[#354957]',
    footerActionLink: 'text-[#176f88]', footerActionText: 'text-[#687984]',
    dividerText: 'text-[#687984]', formButtonPrimary: 'bg-[#176f88] hover:bg-[#125b70]',
    formFieldInput: 'bg-[#f5f7f5] border-[#dce3e4] text-[#233342]',
    socialButtonsBlockButton: 'border-[#dce3e4] bg-white', alertText: 'text-[#8c3c36]',
  },
};

function SpinnerBlock({ label = 'Loading roster data' }: { label?: string }) {
  return <div className="loading-panel" role="status" data-testid="status-loading">
    <span className="skeleton skeleton-mark" /><span className="skeleton skeleton-line" />
    <span className="skeleton skeleton-line short" /><span className="sr-only">{label}</span>
  </div>;
}

function QueryError({ message = 'We could not load this information.', retry }: { message?: string; retry?: () => void }) {
  return <div className="state-panel error-state" role="alert" data-testid="status-error">
    <CircleAlert size={22} /><strong>Something needs another try.</strong><span>{message}</span>
    {retry && <button className="button button-secondary" onClick={retry} data-testid="button-retry">Try again</button>}
  </div>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="state-panel empty-state"><span className="empty-icon"><CalendarDays size={22} /></span>
    <strong>{title}</strong><span>{detail}</span>{action}</div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-symbol"><Stethoscope size={18} strokeWidth={2.3} /></span>
    {!compact && <span className="brand-copy"><strong>Aman</strong><small>TEAM SHIFTS</small></span>}</div>;
}

function PublicHome() {
  return <main className="welcome-page">
    <header className="welcome-nav"><Link href="/" className="brand-link"><Brand /></Link>
      <nav><a href="#how-it-works">How it works</a><a href="#for-teams">For nursing teams</a>
        <Link href="/sign-in" className="button button-quiet">Sign in <ArrowRight size={15} /></Link></nav></header>
    <section className="welcome-hero">
      <div className="hero-copy"><span className="eyebrow"><span className="eyebrow-dot" /> Aman Nursing · Doha, Qatar</span>
        <h1>Every shift,<br /><em>in its place.</em></h1>
        <p>A clear, dependable view of your team’s published roster. Know where you need to be, and when.</p>
        <div className="hero-actions"><Link href="/sign-in" className="button button-primary">Open your schedule <ArrowRight size={16} /></Link>
          <Link href="/sign-up" className="text-link">New to Aman? Create an account</Link></div>
        <div className="hero-note"><ShieldCheck size={16} /><span>Published by your scheduling team. Always up to date.</span></div>
      </div>
      <div className="hero-art" aria-label="Illustration of an organized shift calendar">
        <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
         <div className="floating-tag tag-top"><span className="tag-dot blue" /> D</div>
        <div className="schedule-preview">
          <div className="preview-head"><div><small>TEAM ROSTER</small><strong>November 2026</strong></div><CalendarDays size={19} /></div>
          <div className="preview-week">{['S','M','T','W','T','F','S'].map((d,i)=><span key={`${d}${i}`}>{d}</span>)}</div>
          <div className="preview-days">{[15,16,17,18,19,20,21].map(d=><span className={d===19?'selected':''} key={d}>{d}</span>)}</div>
          <div className="preview-label">THURSDAY · 19 NOV <span>OR/PACU</span></div>
           <div className="preview-shift"><span className="preview-avatar">LF</span><div><b>Layla Faris</b><small>D</small></div><i className="shift-bar blue-bar" /></div>
           <div className="preview-shift"><span className="preview-avatar avatar-green">MS</span><div><b>Mira Sen</b><small>M</small></div><i className="shift-bar green-bar" /></div>
           <div className="preview-shift"><span className="preview-avatar avatar-sand">RK</span><div><b>Rana Khoury</b><small>D1</small></div><i className="shift-bar sand-bar" /></div>
        </div>
        <div className="floating-tag tag-bottom"><span className="tag-dot green" /> Published <b>v12</b><Check size={14} /></div>
      </div>
    </section>
    <section className="welcome-proof" id="for-teams"><div className="proof-lead"><span className="eyebrow">BUILT FOR THE REAL SHIFT</span><h2>Less roster hunting.<br /><em>More peace of mind.</em></h2></div>
      <div className="proof-item"><span>01</span><div><strong>One trusted schedule</strong><p>See the latest published month, not an old screenshot buried in a chat.</p></div></div>
      <div className="proof-item"><span>02</span><div><strong>Made for a quick check</strong><p>Shift colors, team names, and dates are easy to scan between rounds.</p></div></div>
      <div className="proof-item"><span>03</span><div><strong>Changes with a clear trail</strong><p>Scheduling admins can review imports, publish updates, and restore a version.</p></div></div>
    </section>
    <section className="welcome-bottom" id="how-it-works"><div><span className="eyebrow">A STEADY COMPANION</span><h2>Clear today.<br />Ready for next month.</h2></div>
      <div><p>Rosters are prepared by your team and published when they’re ready. Aman keeps the schedule simple, current, and easy to return to.</p>
        <Link href="/sign-in" className="button button-light">Continue to Aman <ArrowRight size={16} /></Link></div>
      <footer><Brand compact /><span>For Aman Nursing teams · Asia/Qatar</span><span>English-first · RTL-ready</span></footer>
    </section>
  </main>;
}

type NavItem = { label: string; href: string; icon: ReactNode; admin?: boolean };
const navItems: NavItem[] = [
  { label: 'Overview', href: '/dashboard', icon: <LayoutDashboard size={17} /> },
  { label: 'Team schedule', href: '/schedule', icon: <CalendarDays size={17} /> },
  { label: 'My shifts', href: '/my-schedule', icon: <Clock3 size={17} /> },
  { label: 'Employees', href: '/admin/employees', icon: <Users size={17} />, admin: true },
  { label: 'Departments', href: '/admin/departments', icon: <Settings2 size={17} />, admin: true },
  { label: 'Shift types', href: '/admin/shifts', icon: <Stethoscope size={17} />, admin: true },
  { label: 'Roster imports', href: '/admin/imports', icon: <FileSpreadsheet size={17} />, admin: true },
  { label: 'Version history', href: '/admin/history', icon: <ArrowDownToLine size={17} />, admin: true },
  { label: 'Admin activity', href: '/admin/activity', icon: <Activity size={17} />, admin: true },
];

function AppShell({ children, title }: { children: ReactNode; title: string }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { signOut } = useClerk();
  const { data: user, isLoading } = useGetCurrentUser();
  const admin = user?.role === 'admin';
  const visibleNav = navItems.filter(item => !item.admin || admin);
  const initial = user?.fullName?.split(' ').map(x => x[0]).slice(0,2).join('').toUpperCase() || 'A';
  return <div className="app-frame">
    {mobileOpen && <button className="mobile-scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <Link href="/dashboard" className="sidebar-brand"><Brand /></Link>
      <div className="side-section-label">YOUR WORKSPACE</div>
      <nav className="side-nav">{visibleNav.map(item=><Link key={item.href} href={item.href}
        onClick={() => setMobileOpen(false)} className={`side-link ${location===item.href?'active':''}`} data-testid={`link-nav-${item.href.slice(1).replaceAll('/','-')}`}>
        {item.icon}<span>{item.label}</span>{item.href==='/admin/imports' && <span className="nav-indicator" />}</Link>)}</nav>
      {admin && <div className="sidebar-bottom"><div className="team-badge"><span className="team-badge-icon"><ShieldCheck size={16} /></span>
        <span><b>Scheduling admin</b><small>Roster controls enabled</small></span></div></div>}
      <button className="sidebar-user" onClick={() => signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out">
        <span className="user-avatar">{initial}</span><span className="user-meta"><b>{user?.fullName || (isLoading?'Loading account':'Aman user')}</b><small>{admin?'Administrator':'Nursing staff'}</small></span>
        <LogOut size={16} className="logout-icon" /></button>
    </aside>
    <main className="main-stage">
      <header className="topbar"><button className="icon-button menu-trigger" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button>
        <div className="breadcrumb"><span>AMAN NURSING</span><span className="crumb-slash">/</span><b>{title}</b></div>
        <div className="topbar-right"><span className="timezone-pill"><span /> GMT+03:00 · Doha</span><span className="top-avatar">{initial}</span></div></header>
      <div className="page-content">{children}</div>
      <footer className="app-footer"><span>Aman Team Shifts</span><span>Asia/Qatar · Weeks begin Sunday</span></footer>
    </main>
  </div>;
}

function SignedInOnly({ children }: { children: ReactNode }) {
  return <><Show when="signed-in">{children}</Show><Show when="signed-out"><Redirect to="/" /></Show></>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const {data:user,isLoading,isError,refetch}=useGetCurrentUser();
  if(isLoading)return <AppShell title="Checking access"><SpinnerBlock label="Checking account permissions"/></AppShell>;
  if(isError)return <AppShell title="Access unavailable"><QueryError message="We could not confirm your account permissions." retry={()=>refetch()}/></AppShell>;
  if(user?.role!=='admin')return <AppShell title="Admin access"><div className="state-panel"><ShieldCheck size={22}/><strong>Scheduling admin access required</strong><span>Your account can view published schedules. Contact your scheduling administrator if you need roster tools.</span><Link href="/dashboard" className="button button-primary">Back to overview</Link></div></AppShell>;
  return <>{children}</>;
}

function PageHeading({ eyebrow, title, detail, actions }: { eyebrow?: string; title: string; detail?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{detail && <p>{detail}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}

function DashboardPage() {
  const [month,setMonth] = useState(monthNow());
  const {data: user} = useGetCurrentUser();
  const {data: summary,isLoading,isError,refetch} = useGetDashboardSummary({month});
  const admin=user?.role==='admin';
  const activityQuery = useGetRecentActivity({limit:5},{query:{enabled:admin,queryKey:getGetRecentActivityQueryKey({limit:5})}});
  return <AppShell title="Overview"><PageHeading eyebrow="YOUR SHIFT COMPANION" title={`Good day${user?.fullName ? `, ${user.fullName.split(' ')[0]}` : ''}.`}
    detail="A dependable view of the roster your team has published."
    actions={<MonthPicker month={month} onChange={setMonth} />}/>
    {isLoading ? <SpinnerBlock /> : isError || !summary ? <QueryError retry={()=>refetch()} /> : <>
      <div className="dashboard-banner">
        <div className="banner-mark"><CalendarDays size={21}/></div><div className="banner-copy">
          <small>ROSTER STATUS · {monthLabel(month).toUpperCase()}</small>
          <strong>{summary.publishedVersion ? `Published version ${summary.publishedVersion}` : 'No published roster yet'}</strong>
          <span>{summary.publishedAt ? `Last published ${fmtDate(summary.publishedAt.slice(0,10),{day:'numeric',month:'short',year:'numeric'})}` : 'Your scheduling team will publish when it is ready.'}</span>
        </div><Link href={admin?'/admin/history':'/schedule'} className="button button-light">
          {admin?'Review versions':'View schedule'} <ArrowRight size={15}/></Link>
      </div>
      <div className="metric-grid">
        <Metric label="Team members" value={summary.employeeCount} caption="Across your roster" icon={<Users size={18}/>} />
        <Metric label="Departments" value={summary.departmentCount} caption="Configured teams" icon={<Stethoscope size={18}/>} />
        <Metric label="Assigned shifts" value={summary.assignedShiftCount} caption={`${monthLabel(month)} roster`} icon={<Clock3 size={18}/>} />
        {admin && <Metric label="Imports to review" value={summary.importReviewCount} caption="Needs your attention" icon={<FileSpreadsheet size={18}/>} alert={summary.importReviewCount>0} />}
      </div>
      <div className="dashboard-columns">
        <section className="surface schedule-shortcut"><div className="section-head"><div><div className="eyebrow">THE MONTH AHEAD</div><h2>Your roster, at a glance</h2></div><Link href="/schedule" className="arrow-link">Open schedule <ArrowRight size={15}/></Link></div>
          <CalendarPreview month={month} /></section>
        <section className="surface activity-card"><div className="section-head"><div><div className="eyebrow">KEEPING TRACK</div><h2>Recent changes</h2></div><Link href={admin?'/admin/activity':'/schedule'} className="arrow-link">{admin?'All activity':'Open schedule'} <ArrowRight size={15}/></Link></div>
          {activityQuery.isLoading?<div className="mini-skeleton"><i/><i/><i/></div>:
            activityQuery.isError?<QueryError message="Recent changes are temporarily unavailable." retry={()=>activityQuery.refetch()}/>:
              <ActivityList items={activityQuery.data||[]} compact />}</section>
      </div>
    </>}
  </AppShell>;
}

function Metric({label,value,caption,icon,alert=false}:{label:string;value:number;caption:string;icon:ReactNode;alert?:boolean}) {
  return <div className={`metric-card ${alert?'metric-alert':''}`}><span className="metric-icon">{icon}</span><span className="metric-number">{value.toLocaleString('en')}</span><span className="metric-label">{label}</span><span className="metric-caption">{caption}</span></div>;
}

function MonthPicker({month,onChange}:{month:string;onChange:(month:string)=>void}) {
  const move=(n:number)=>{const d=new Date(`${month}-01T12:00:00`);d.setMonth(d.getMonth()+n);onChange(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)};
  return <div className="month-picker"><button className="icon-button" onClick={()=>move(-1)} aria-label="Previous month"><ChevronLeft size={18}/></button>
    <span>{monthLabel(month)}</span><button className="icon-button" onClick={()=>move(1)} aria-label="Next month"><ChevronRight size={18}/></button></div>;
}

function CalendarPreview({month}:{month:string}) {
  const year=Number(month.slice(0,4)),mon=Number(month.slice(5,7))-1, first=new Date(year,mon,1), start=new Date(year,mon,1-first.getDay());
  const days=Array.from({length:42},(_,i)=>{const d=new Date(start);d.setDate(start.getDate()+i);return d;});
  const today=dateQatar(new Date());
  return <div className="calendar-preview"><div className="cal-week-head">{['S','M','T','W','T','F','S'].map((x,i)=><span key={`${x}${i}`}>{x}</span>)}</div>
    <div className="cal-grid">{days.map((d,i)=>{const ds=dateQatar(d), inMonth=d.getMonth()===mon;return <span key={i} className={`cal-day ${!inMonth?'outside':''} ${ds===today?'today':''}`}>{d.getDate()}</span>})}</div>
    <div className="calendar-note"><span className="published-dot"/><span>Monthly roster overview</span><span className="cal-note-tail">Sunday start</span></div></div>;
}

function ActivityList({items,compact=false}:{items:ActivityItem[];compact?:boolean}) {
  if (!items.length) return <EmptyState title="No activity yet" detail="Roster updates and publications will appear here." />;
  return <div className={`activity-list ${compact?'compact':''}`}>{items.map(item=><div className="activity-row" key={item.id}>
    <span className="activity-mark"><Activity size={15}/></span><div><strong>{item.action}</strong><span>{item.subject}</span></div>
    <time>{item.actorName} · {new Intl.DateTimeFormat('en',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:'Asia/Qatar'}).format(new Date(item.createdAt))}</time>
  </div>)}</div>;
}

function SchedulePage({mine=false}:{mine?:boolean}) {
  const [month,setMonth]=useState(monthNow());
  const [departmentId,setDepartmentId]=useState('');
  const [selectedDate,setSelectedDate]=useState(dateQatar(new Date()));
  const {data:departments=[]}=useListDepartments();
  const scheduleParams={month,...(departmentId?{departmentId}:{})};
  const teamQuery=useGetMonthlySchedule(scheduleParams,{query:{enabled:!mine,queryKey:getGetMonthlyScheduleQueryKey(scheduleParams)}});
  const mineQuery=useGetMySchedule({month},{query:{enabled:mine,queryKey:getGetMyScheduleQueryKey({month})}});
  const schedule=mine?mineQuery.data:teamQuery.data;
  const isLoading=mine?mineQuery.isLoading:teamQuery.isLoading;
  const isError=mine?mineQuery.isError:teamQuery.isError;
  const refetch=mine?mineQuery.refetch:teamQuery.refetch;
  const {data:user}=useGetCurrentUser();
  const [editAssignment,setEditAssignment]=useState<ShiftAssignment|null|false>(false);
   const rows=schedule?.assignments.filter(a=>a.date===selectedDate&&a.displayInCalendar) ?? [];
  const grouped=useMemo(()=>rows.reduce<Record<string,ShiftAssignment[]>>((acc,a)=>{(acc[a.departmentName]??=[]).push(a);return acc;},{}),[rows]);
  const admin=user?.role==='admin';
  const changeMonth=(next:string)=>{setMonth(next);setSelectedDate(`${next}-01`);};
  const dateCount=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate();
  const leadingCells=new Date(Number(month.slice(0,4)),Number(month.slice(5,7))-1,1).getDay();
  const dates=Array.from({length:dateCount},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
  const creates=useCreateRosterAssignment({mutation:{onSuccess:()=>{if(schedule?.versionId)invalidate(getGetRosterVersionScheduleQueryKey(schedule.versionId));invalidateRosterReads();setEditAssignment(false);}}});
  const updates=useUpdateRosterAssignment({mutation:{onSuccess:()=>{if(schedule?.versionId)invalidate(getGetRosterVersionScheduleQueryKey(schedule.versionId));invalidateRosterReads();setEditAssignment(false);}}});
  const deletes=useDeleteRosterAssignment({mutation:{onSuccess:()=>{if(schedule?.versionId)invalidate(getGetRosterVersionScheduleQueryKey(schedule.versionId));invalidateRosterReads();}}});
  const allEmployees=useListEmployees({activeOnly:true},{query:{enabled:admin,queryKey:getListEmployeesQueryKey({activeOnly:true})}});
  const shiftTypes=useListShiftTypes({query:{enabled:admin,queryKey:getListShiftTypesQueryKey()}});
  const saveAssignment=(data:Record<string,string>)=>{
    const payload={date:data.date,employeeId:data.employeeId,shiftTypeId:data.shiftTypeId,notes:data.notes||null};
    if(!schedule?.versionId)return;
    if(editAssignment) updates.mutate({versionId:schedule.versionId,assignmentId:editAssignment.id,data:payload});
    else creates.mutate({versionId:schedule.versionId,data:payload});
  };
  return <AppShell title={mine?'My shifts':'Team schedule'}>
    <PageHeading eyebrow={mine?'PERSONAL ROSTER':'PUBLISHED ROSTER'} title={mine?'My schedule':'Team schedule'}
      detail={mine?'Your assigned shifts, as published by the scheduling team.':'Browse published assignments by date and department.'}
      actions={<MonthPicker month={month} onChange={changeMonth}/>}/>
    <div className="schedule-controls">
      <div className="schedule-month-name"><span>{monthLabel(month)}</span><span className="schedule-timezone">Asia/Qatar · GMT+03:00</span></div>
      {!mine && <label className="filter-select"><Filter size={15}/><select value={departmentId} onChange={e=>setDepartmentId(e.target.value)} aria-label="Filter by department" data-testid="select-department-filter">
        <option value="">All departments</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select><ChevronDown size={15}/></label>}
      {admin && !mine && <button className="button button-primary" disabled={schedule?.status!=='draft'||!schedule.versionId} onClick={()=>setEditAssignment(null)} data-testid="button-add-assignment"><Plus size={16}/> Add shift</button>}
    </div>
    {isLoading?<SpinnerBlock/>:isError||!schedule?<QueryError retry={()=>refetch()}/>:<>
      <div className="calendar-strip"><div className="calendar-strip-head">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><span key={d}>{d}</span>)}</div>
         <div className="calendar-date-grid">{Array.from({length:leadingCells},(_,i)=><span className="calendar-leading-cell" aria-hidden="true" key={`blank-${i}`}/>)}{dates.map(d=>{const count=schedule.assignments.filter(a=>a.date===d&&a.isWorking).length;const chosen=d===selectedDate;
          return <button key={d} className={`calendar-date ${chosen?'chosen':''}`} onClick={()=>setSelectedDate(d)} data-testid={`button-date-${d}`}>
            <small>{Number(d.slice(-2))}</small>{count>0&&<i className="date-count">{count>99?'99+':count}</i>}</button>})}</div>
      </div>
      <div className="day-heading"><div><span className="eyebrow">{schedule.status==='published'?'PUBLISHED ROSTER':admin?'DRAFT ROSTER':'ROSTER'}</span><h2>{fmtDate(selectedDate)}</h2></div>
        <span className={`status-pill ${schedule.status==='published'?'status-live':'status-draft'}`}><i/>{schedule.status==='published'?'Published':'Draft'}</span></div>
      {rows.length===0?<EmptyState title="No shifts for this date" detail="Choose another day to see the published team assignments."/>:
        <div className="department-groups">{Object.entries(grouped).map(([department,assignments])=><section className="department-group" key={department}>
         <div className="department-title"><span>{department}</span><span className="department-count">{assignments.filter(a=>a.isWorking).length} active shifts</span></div>
          {assignments.map(a=><ShiftRow assignment={a} key={a.id} admin={admin&&schedule.status==='draft'}
             onEdit={()=>setEditAssignment(a)} onDelete={()=>{if(schedule.versionId&&window.confirm(`Remove ${a.employeeName}’s ${a.shiftCode} assignment?`))deletes.mutate({versionId:schedule.versionId,assignmentId:a.id});}} />)}
        </section>)}</div>}
      {schedule.assignments.length===0&&rows.length===0&&<p className="quiet-note">There are no assignments in this roster version yet.</p>}
    </>}
    {editAssignment!==false&&<FormModal title={editAssignment?'Edit shift assignment':'Add shift assignment'} description="Changes affect this draft roster version."
      fields={[{name:'date',label:'Shift date',type:'date',value:editAssignment?.date||selectedDate},
        {name:'employeeId',label:'Employee',type:'select',options:(allEmployees.data||[]).map(e=>({value:e.id,label:`${e.fullName} · ${e.employeeCode}`})),value:editAssignment?.employeeId},
        {name:'shiftTypeId',label:'Shift type',type:'select',options:(shiftTypes.data||[]).filter(s=>s.active).map(s=>({value:s.id,label:`${s.name} · ${s.code}`})),value:editAssignment?.shiftTypeId},
        {name:'notes',label:'Notes (optional)',value:editAssignment?.notes||''}]}
      busy={creates.isPending||updates.isPending}
      error={creates.isError||updates.isError?'The assignment could not be saved. Please try again.':undefined}
      onClose={()=>setEditAssignment(false)} onSubmit={saveAssignment} submitLabel="Save assignment" />}
     <div className="shift-legend">{shiftTypes.data?.filter(type=>type.active&&type.displayInCalendar).map(type=><span key={type.id}><i className="legend-dot" style={{background:type.color}}/>{type.displayCode??type.code}</span>)}
      <span>Shift colors follow your team’s setup</span></div>
  </AppShell>;
}

function ShiftRow({assignment,admin,onEdit,onDelete}:{assignment:ShiftAssignment;admin:boolean;onEdit:()=>void;onDelete:()=>void}) {
  const initials=assignment.employeeName.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase();
  const shiftLabel=assignment.shiftCode;
  return <div className="shift-row" data-testid={`row-assignment-${assignment.id}`}>
    <span className="staff-avatar">{initials}</span><div className="shift-card" style={{'--shift-color':assignment.shiftColor} as React.CSSProperties}>
      <div className="shift-staff"><strong>{assignment.employeeName}</strong><span>{assignment.employeeCode}</span></div>
       <div className="shift-detail"><span>{shiftLabel}</span>{admin&&assignment.notes&&<small>{assignment.notes}</small>}</div>
      {admin&&<div className="shift-actions"><button onClick={onEdit} aria-label={`Edit ${assignment.employeeName} shift`} data-testid={`button-edit-assignment-${assignment.id}`}>Edit</button><button onClick={onDelete} aria-label={`Delete ${assignment.employeeName} shift`} data-testid={`button-delete-assignment-${assignment.id}`}>Remove</button></div>}
    </div>
  </div>;
}

type Field = {name:string;label:string;type?:string;value?:string|null;options?:{value:string;label:string}[];placeholder?:string;required?:boolean;disabled?:boolean};
function FormModal({title,description,fields,onClose,onSubmit,busy=false,submitLabel='Save changes',error}:{
  title:string;description?:string;fields:Field[];onClose:()=>void;onSubmit:(data:Record<string,string>)=>void;busy?:boolean;submitLabel?:string;error?:string;
}) {
  const handle=(e:FormEvent<HTMLFormElement>)=>{e.preventDefault();const form=new FormData(e.currentTarget);const data:Record<string,string>={};fields.forEach(f=>data[f.name]=String(form.get(f.name)??f.value??''));onSubmit(data);};
  return <div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header><div><h2 id="modal-title">{title}</h2>{description&&<p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19}/></button></header>
      <form onSubmit={handle}><div className="modal-fields">{fields.map(field=><label className="form-field" key={field.name}><span>{field.label}</span>
         {field.type==='select'?<select name={field.name} defaultValue={field.value||''} required={field.required!==false} disabled={field.disabled} data-testid={`select-${field.name}`}>
          <option value="" disabled>Choose {field.label.toLowerCase()}</option>{field.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:
           <input name={field.name} type={field.type||'text'} defaultValue={field.value||''} placeholder={field.placeholder} required={field.required!==false} disabled={field.disabled} data-testid={`input-${field.name}`} />}</label>)}</div>
        {error&&<p className="inline-error" role="alert">{error}</p>}
        <footer><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>
          <button className="button button-primary" disabled={busy} data-testid="button-modal-submit">{busy?'Saving…':submitLabel}</button></footer></form>
    </section>
  </div>;
}

function DirectoryPage({kind}:{kind:'employees'|'departments'|'shifts'}) {
  const titles={employees:'Employee directory',departments:'Departments',shifts:'Shift types'};
  const details={employees:'Keep staff details and department assignments current.',departments:'Set up the teams that organize your published rosters.',shifts:'Configure shift labels and colors used in the roster.'};
  const [search,setSearch]=useState('');
  const [modal,setModal]=useState<{item?:Employee|Department|ShiftType}|null>(null);
  const departments=useListDepartments();
  const employees=useListEmployees({search:search||undefined});
  const shifts=useListShiftTypes();
  const createDepartment=useCreateDepartment({mutation:{onSuccess:()=>{invalidate(getListDepartmentsQueryKey());invalidate(getGetDashboardSummaryQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const updateDepartment=useUpdateDepartment({mutation:{onSuccess:()=>{invalidate(getListDepartmentsQueryKey());invalidate(getListEmployeesQueryKey());invalidate(getGetDashboardSummaryQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const createEmployee=useCreateEmployee({mutation:{onSuccess:()=>{invalidate(getListEmployeesQueryKey());invalidate(getListDepartmentsQueryKey());invalidate(getGetDashboardSummaryQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const updateEmployee=useUpdateEmployee({mutation:{onSuccess:()=>{invalidate(getListEmployeesQueryKey());invalidate(getListDepartmentsQueryKey());invalidate(getGetDashboardSummaryQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const createShift=useCreateShiftType({mutation:{onSuccess:()=>{invalidate(getListShiftTypesQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const updateShift=useUpdateShiftType({mutation:{onSuccess:()=>{invalidate(getListShiftTypesQueryKey());invalidate(getGetRecentActivityQueryKey());setModal(null);}}});
  const pending=createDepartment.isPending||updateDepartment.isPending||createEmployee.isPending||updateEmployee.isPending||createShift.isPending||updateShift.isPending;
  const save=(data:Record<string,string>)=>{
    if(kind==='departments'){
      const payload={code:data.code.toUpperCase(),name:data.name,timezone:data.timezone||'Asia/Qatar'};
      if(modal?.item)updateDepartment.mutate({departmentId:(modal.item as Department).id,data:payload});
      else createDepartment.mutate({data:payload});
    } else if(kind==='employees'){
      const payload={employeeCode:data.employeeCode.toUpperCase(),fullName:data.fullName,jobTitle:data.jobTitle,departmentId:data.departmentId,email:data.email||null};
      if(modal?.item)updateEmployee.mutate({employeeId:(modal.item as Employee).id,data:payload});
      else createEmployee.mutate({data:payload});
    } else {
      const payload={code:data.code.toUpperCase(),category:(data.category||'working') as 'working'|'attendance',name:data.name,
        meaning:data.meaning||null,color:data.color,displayCode:data.displayCode,displayInCalendar:data.displayInCalendar!=='false',
        startsAt:data.startsAt||null,endsAt:data.endsAt||null};
      if(modal?.item)updateShift.mutate({shiftTypeId:(modal.item as ShiftType).id,data:payload});
      else createShift.mutate({data:payload});
    }
  };
  const isLoading=kind==='departments'?departments.isLoading:kind==='employees'?employees.isLoading:shifts.isLoading;
  const isError=kind==='departments'?departments.isError:kind==='employees'?employees.isError:shifts.isError;
  const list=kind==='departments'?departments.data:kind==='employees'?employees.data:shifts.data;
  const retry=()=>kind==='departments'?departments.refetch():kind==='employees'?employees.refetch():shifts.refetch();
  const fields=(item?:Employee|Department|ShiftType):Field[]=>{
    if(kind==='departments'){const d=item as Department|undefined;return [
      {name:'name',label:'Department name',value:d?.name},{name:'code',label:'Short code',value:d?.code},
      {name:'timezone',label:'Timezone',value:d?.timezone||'Asia/Qatar'}];}
    if(kind==='employees'){const e=item as Employee|undefined;return [
      {name:'fullName',label:'Full name',value:e?.fullName},{name:'employeeCode',label:'Employee code',value:e?.employeeCode},
      {name:'jobTitle',label:'Job title',value:e?.jobTitle},{name:'departmentId',label:'Department',type:'select',value:e?.departmentId,
        options:(departments.data||[]).map(d=>({value:d.id,label:d.name}))},{name:'email',label:'Work email',type:'email',required:false,value:e?.email}];}
    const s=item as ShiftType|undefined;
    const systemCode=s?['D','N','M','D1','AL','CL','EL','R','OFF','/','BLANK'].includes(s.code):false;
    const fixedWorkDefinition=Boolean(s&&['D','N','M','D1'].includes(s.code));
    return [
      {name:'category',label:'Category',type:'select',value:s?.category||'working',disabled:systemCode,
        options:[{value:'working',label:'Working shift'},{value:'attendance',label:'Attendance status'}]},
      {name:'name',label:'Name',value:s?.name,disabled:fixedWorkDefinition},
      {name:'code',label:'Code',value:s?.code,disabled:systemCode},
      {name:'meaning',label:'Meaning (optional)',value:s?.meaning,required:false,disabled:fixedWorkDefinition},
      {name:'color',label:'Display color',type:'color',value:s?.color||'#9acfe6',disabled:fixedWorkDefinition},
      {name:'displayCode',label:'Calendar code',value:s?.displayCode??s?.code,required:false,disabled:fixedWorkDefinition},
      {name:'displayInCalendar',label:'Show in calendar',type:'select',value:String(s?.displayInCalendar??true),disabled:fixedWorkDefinition,
        options:[{value:'true',label:'Show'},{value:'false',label:'Hide'}]},
      {name:'startsAt',label:'Internal start time',type:'time',required:false,value:s?.startsAt,disabled:systemCode},
      {name:'endsAt',label:'Internal end time',type:'time',required:false,value:s?.endsAt,disabled:systemCode}];
  };
  const toggleActive=(employee:Employee)=>updateEmployee.mutate({employeeId:employee.id,data:{active:!employee.active}});
  return <AppShell title={titles[kind]}><PageHeading eyebrow="ROSTER SETUP" title={titles[kind]} detail={details[kind]}
      actions={<button className="button button-primary" onClick={()=>setModal({})} data-testid="button-create-item"><Plus size={16}/>{kind==='employees'?'Add employee':kind==='departments'?'Add department':'Add shift type'}</button>}/>
    <div className="directory-toolbar"><div className="directory-count"><b>{list?.length??'—'}</b> {kind==='employees'?'team members':kind==='departments'?'departments':'shift types'}</div>
      {kind==='employees'&&<label className="search-box"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name or employee code" data-testid="input-search-employees"/><span>⌘ K</span></label>}
    </div>
    {isLoading?<SpinnerBlock/>:isError?<QueryError retry={()=>retry()}/>:!list?.length?<EmptyState title={`No ${kind} added yet`} detail={`Add ${kind==='employees'?'team members':kind==='departments'?'a department':'shift types'} to keep your roster organized.`}/>:kind==='employees'?
      <section className="directory-list">{(employees.data||[]).map(e=><article className="employee-card" key={e.id} data-testid={`row-employee-${e.id}`}>
        <span className="employee-avatar">{e.fullName.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase()}</span><div className="employee-main"><strong>{e.fullName}</strong><span>{e.jobTitle}</span></div>
        <span className="employee-code">{e.employeeCode}</span><span className="employee-dept">{e.departmentName}</span><span className={`employee-status ${e.active?'active':'inactive'}`}><i/>{e.active?'Active':'Inactive'}</span>
        <div className="row-actions"><button onClick={()=>setModal({item:e})} data-testid={`button-edit-employee-${e.id}`}>Edit</button><button onClick={()=>toggleActive(e)} data-testid={`button-toggle-employee-${e.id}`}>{e.active?'Deactivate':'Reactivate'}</button></div>
      </article>)}</section>:kind==='departments'?
      <section className="setup-list">{(departments.data||[]).map(d=><article className="setup-row" key={d.id} data-testid={`row-department-${d.id}`}>
        <span className="setup-icon"><Stethoscope size={19}/></span><div className="setup-main"><strong>{d.name}</strong><span>{d.code} · {d.timezone}</span></div>
        <div className="setup-count"><b>{d.employeeCount}</b><span>members</span></div><button className="button button-secondary button-small" onClick={()=>setModal({item:d})} data-testid={`button-edit-department-${d.id}`}>Edit</button>
      </article>)}</section>:
      <section className="shift-type-list">{(shifts.data||[]).map(s=><article className="shift-type-row" key={s.id} data-testid={`row-shift-${s.id}`}>
         <span className="shift-swatch" style={{background:s.color}}/><div className="shift-type-main"><strong>{s.name}<small>{s.code} · {s.category==='working'?'Working':'Attendance'}</small></strong><span>{s.meaning|| (s.startsAt&&s.endsAt?`${fmtTime(s.startsAt)} – ${fmtTime(s.endsAt)}`:'Meaning not specified')}</span></div>
        <span className={`employee-status ${s.active?'active':'inactive'}`}><i/>{s.active?'Active':'Inactive'}</span>
         <button className="button button-quiet button-small" disabled={['D','N','M','D1','AL','CL','EL','R','OFF','/','BLANK'].includes(s.code)} onClick={()=>updateShift.mutate({shiftTypeId:s.id,data:{active:!s.active}})} data-testid={`button-toggle-shift-${s.id}`}>{s.active?'Deactivate':'Reactivate'}</button>
        <button className="button button-secondary button-small" onClick={()=>setModal({item:s})} data-testid={`button-edit-shift-${s.id}`}>Edit</button>
      </article>)}</section>}
    {modal&&<FormModal title={`${modal.item?'Edit':'Add'} ${kind==='employees'?'employee':kind==='departments'?'department':'shift type'}`}
      description={kind==='shifts'?'This color identifies the shift in schedule views.':undefined} fields={fields(modal.item)}
      busy={pending} error={createDepartment.isError||updateDepartment.isError||createEmployee.isError||updateEmployee.isError||createShift.isError||updateShift.isError?'The change could not be saved. Review the details and try again.':undefined}
      onClose={()=>setModal(null)} onSubmit={save} submitLabel={modal.item?'Save changes':'Add to roster'} />}
  </AppShell>;
}

function ImportsPage() {
  const [month,setMonth]=useState(monthNow());
  const [preview,setPreview]=useState<ImportPreview|null>(null);
  const [mapping,setMapping]=useState<ImportMapping|null>(null);
  const [file,setFile]=useState<File|null>(null);
  const [mode,setMode]=useState<'replace'|'merge'>('replace');
  const [publish,setPublish]=useState(false);
  const [employeeMap,setEmployeeMap]=useState<Record<string,string>>({});
  const [shiftMap,setShiftMap]=useState<Record<string,string>>({});
  const imports=useListRosterImports();
  const employees=useListEmployees({activeOnly:true});
  const shifts=useListShiftTypes();
  const previewMutation=usePreviewRosterImport({mutation:{onSuccess:(data)=>{setPreview(data);setMapping(data.mapping);setEmployeeMap(Object.fromEntries(data.records.filter(r=>!r.sourceEmployeeId).map(r=>[String(r.rowNumber),r.employeeId||''])));setShiftMap({});invalidate(getListRosterImportsQueryKey());}}});
  const resolveMutation=useResolveRosterImport({mutation:{onSuccess:(data)=>{setPreview(data);invalidate(getListRosterImportsQueryKey());}}});
  const confirmMutation=useConfirmRosterImport({mutation:{onSuccess:()=>{setPreview(null);setFile(null);invalidate(getListRosterImportsQueryKey());invalidateRosterReads();}}});
  const setFileFromInput=(e:FormEvent<HTMLInputElement>)=>{const target=e.currentTarget;setFile(target.files?.[0]||null);};
  const runPreview=()=>{if(file)previewMutation.mutate({data:{file,month,mappingJson:mapping?JSON.stringify(mapping):undefined}});};
  const columns=['format','employeeIdColumn','employeeNameColumn','departmentColumn','dateColumn','shiftCodeColumn'] as const;
  const mappingFieldNames:Record<(typeof columns)[number],string>={format:'Format',employeeIdColumn:'Employee ID column',employeeNameColumn:'Employee name column',departmentColumn:'Department column',dateColumn:'Date column',shiftCodeColumn:'Shift code column'};
  const resolve=()=>{
    if(!preview)return;
    resolveMutation.mutate({importId:preview.import.id,data:{
       employees:Array.from(new Map(preview.records.filter(record=>!record.employeeId||!record.sourceEmployeeId)
         .map(record=>[record.rowNumber,record])).values()).flatMap(record=>{
           const employeeId=employeeMap[String(record.rowNumber)];
           return employeeId?[{rowNumber:record.rowNumber,employeeId}]:[];
         }),
      shiftCodes:Object.entries(shiftMap).filter(([,shiftTypeId])=>shiftTypeId).map(([shiftCode,shiftTypeId])=>({shiftCode,shiftTypeId})),
    }});
  };
  const employeeRows=Array.from(new Map((preview?.records||[]).filter(r=>!r.employeeId||!r.sourceEmployeeId)
    .map(record=>[record.rowNumber,record])).values());
  const unknownShifts=Array.from(new Set(preview?.records.filter(r=>!r.shiftTypeId&&r.shiftCode).map(r=>r.shiftCode)||[]));
  const unresolved=employeeRows.some(record=>!employeeMap[String(record.rowNumber)])||unknownShifts.some(code=>!shiftMap[code]);
  const staffCount=new Set((preview?.records||[]).map(record=>record.rowNumber)).size;
  const dateCount=new Set((preview?.records||[]).map(record=>record.date).filter(Boolean)).size;
  return <AppShell title="Roster imports"><PageHeading eyebrow="MONTHLY ROSTER" title="Roster imports" detail="Upload a prepared Excel roster, resolve any unfamiliar values, then review before it becomes the team schedule."
      actions={<MonthPicker month={month} onChange={setMonth}/>}/>
    <div className="import-layout">
      <section className="import-primary">
        <div className="surface import-upload"><div className="section-head"><div><div className="eyebrow">STEP 01 · SOURCE FILE</div><h2>Choose a roster file</h2></div><span className="format-chip">.xlsx</span></div>
          <label className={`drop-zone ${file?'has-file':''}`}><input type="file" accept=".xlsx" onChange={setFileFromInput} data-testid="input-roster-file"/>
            <span className="drop-icon"><FileSpreadsheet size={22}/></span><strong>{file?file.name:'Select an .xlsx roster'}</strong>
            <small>{file?`${(file.size/1024).toFixed(0)} KB · ${monthLabel(month)}`:'Your file is reviewed before any roster changes are made.'}</small>
            <span className="button button-secondary button-small">{file?'Choose another':'Browse files'}</span></label>
          <div className="import-month"><label>Fallback month</label><input type="month" value={month} onChange={e=>setMonth(e.target.value)} data-testid="input-import-month"/>
            <button className="button button-primary" onClick={runPreview} disabled={!file||previewMutation.isPending} data-testid="button-preview-import">
              {previewMutation.isPending?'Reading file…':'Preview roster'} <ArrowRight size={15}/></button></div>
          <p className="muted-copy">Dates in the workbook determine the roster period; this month is only used when date headers omit a year.</p>
          {previewMutation.isError&&<p className="inline-error"><CircleAlert size={15}/> The file could not be previewed. Check the format and try again.</p>}
        </div>
        {preview&&<section className="surface preview-panel">
          <div className="section-head"><div><div className="eyebrow">STEP 02 · REVIEW</div><h2>Import preview</h2></div>
            <span className={`status-pill ${preview.import.issueCount?'status-review':'status-live'}`}><i/>{preview.import.issueCount?`${preview.import.issueCount} issues`:'Ready to review'}</span></div>
          <div className="preview-stats"><span><b>{preview.import.rowCount}</b> cells</span><span><b>{staffCount}</b> staff</span><span><b>{dateCount}</b> dates</span><span><b>{preview.import.validCount}</b> resolved</span><span><b>{preview.import.issueCount}</b> need attention</span></div>
          <p className="muted-copy">Period: {preview.periodStart||'—'} to {preview.periodEnd||'—'}{preview.selectedWorksheet?` · Worksheet: ${preview.selectedWorksheet}`:''}</p>
          <div className="mapping-grid">{columns.map(key=><label className="form-field" key={key}><span>{mappingFieldNames[key]}</span><select value={mapping?.[key]||''} onChange={e=>setMapping(prev=>({...prev!,[key]:e.target.value||null}))}>
            {key==='format'?<>{['auto','wide','long'].map(v=><option key={v} value={v}>{v==='auto'?'Automatic':v==='wide'?'Wide format':'Long format'}</option>)}</>:
              <><option value="">Not mapped</option>{preview.columns.map(col=><option value={col} key={col}>{col}</option>)}</>}</select></label>)}</div>
          {preview.worksheetChoices.length>1&&<label className="form-field worksheet-choice"><span>Confirm latest worksheet</span><select value={mapping?.worksheetName||''} onChange={e=>setMapping(prev=>({...prev!,worksheetName:e.target.value||null}))}><option value="">Choose worksheet</option>{preview.worksheetChoices.map(name=><option key={name} value={name}>{name}</option>)}</select><small>Choose the correct sheet, then preview again.</small></label>}
          {preview.records.length>0&&<div className="table-wrap preview-table"><table><thead><tr><th>Row</th><th>Date</th><th>Employee</th><th>Shift</th><th>Check</th></tr></thead>
            <tbody>{preview.records.slice(0,12).map((r,i)=><tr key={`${r.rowNumber}-${r.date}-${i}`}><td>{r.rowNumber}</td><td>{r.date||'—'}</td><td>{r.sourceEmployeeName||r.employeeName||r.sourceEmployeeId||'—'}</td><td>{r.shiftCode||'Blank cell'}</td><td><span className={`mini-status ${r.valid?'valid':'invalid'}`}>{r.valid?'Valid':'Check'}</span></td></tr>)}</tbody></table>
            {preview.records.length>12&&<p className="table-footnote">Showing 12 of {preview.records.length} cells.</p>}</div>}
          {(employeeRows.length>0||unknownShifts.length>0)&&<div className="resolution-box"><div className="eyebrow">MATCH UNRECOGNIZED VALUES</div><p>Connect imported codes to the current team directory before confirming.</p>
            {employeeRows.map(record=><label className="resolution-row" key={`emp-${record.rowNumber}`}><span>Row {record.rowNumber} · <b>{record.sourceEmployeeName||record.sourceEmployeeId||record.employeeName}</b>{!record.sourceEmployeeId?' · Missing ID':''}</span><select value={employeeMap[String(record.rowNumber)]||''} onChange={e=>setEmployeeMap(m=>({...m,[String(record.rowNumber)]:e.target.value}))}><option value="">Choose employee</option>{(employees.data||[]).map(e=><option key={e.id} value={e.id}>{e.fullName} · {e.employeeCode}</option>)}</select></label>)}
            {unknownShifts.map(code=><label className="resolution-row" key={`shift-${code}`}><span>Shift code <b>{code}</b></span><select value={shiftMap[code]||''} onChange={e=>setShiftMap(m=>({...m,[code]:e.target.value}))}><option value="">Choose shift type</option>{(shifts.data||[]).map(s=><option key={s.id} value={s.id}>{s.name} · {s.code}</option>)}</select></label>)}
            <button className="button button-secondary" disabled={unresolved||resolveMutation.isPending} onClick={resolve} data-testid="button-resolve-import">{resolveMutation.isPending?'Applying matches…':'Apply matches'}</button>
          </div>}
          {preview.issues.length>0&&<div className="issue-list">{preview.issues.map((issue,i)=><div className="issue-row" key={`${issue.code}-${i}`}><CircleAlert size={15}/><span>{issue.rowNumber?`Row ${issue.rowNumber}: `:''}{issue.message}</span></div>)}</div>}
          <div className="confirm-import"><div className="confirm-options"><label className="form-field"><span>Apply to roster</span><select value={mode} onChange={e=>setMode(e.target.value as 'replace'|'merge')}><option value="replace">Replace this roster period</option><option value="merge">Merge with existing shifts</option></select></label>
            <label className="publish-toggle"><input type="checkbox" checked={publish} onChange={e=>setPublish(e.target.checked)}/><span><b>Publish immediately</b><small>Make this version visible to the team.</small></span></label></div>
            <button className="button button-primary" disabled={confirmMutation.isPending||preview.import.validCount===0||preview.import.issueCount>0||unresolved}
              onClick={()=>confirmMutation.mutate({importId:preview.import.id,data:{mode,publish}})} data-testid="button-confirm-import">{confirmMutation.isPending?'Saving roster…':'Confirm roster'} <Check size={16}/></button></div>
          {confirmMutation.isError&&<p className="inline-error"><CircleAlert size={15}/> This roster could not be confirmed. Your existing published schedule is unchanged.</p>}
        </section>}
      </section>
      <aside className="import-aside"><section className="surface import-guidance"><div className="eyebrow">BEFORE YOU UPLOAD</div><h3>A careful review comes first.</h3>
          <ul><li><i>1</i><span>Upload the prepared roster; actual date cells determine its period.</span></li><li><i>2</i><span>Check the detected columns, names, and shift codes.</span></li><li><i>3</i><span>Resolve any unfamiliar values; preview does not publish.</span></li><li><i>4</i><span>Confirm merge or replace only when the preview is clean.</span></li></ul>
          <div className="guidance-note"><ShieldCheck size={17}/><span>Only a confirmed version can change the team schedule.</span></div></section>
        <section className="surface import-history"><div className="section-head"><div><div className="eyebrow">RECENT FILES</div><h3>Import history</h3></div></div>
          {imports.isLoading?<div className="mini-skeleton"><i/><i/><i/></div>:imports.isError?<QueryError message="Recent imports are unavailable." retry={()=>imports.refetch()}/>:!imports.data?.length?<p className="muted-copy">Uploaded roster files will be listed here.</p>:
             <div className="import-history-list">{imports.data.slice(0,6).map(item=><div className="import-history-row" key={item.id}><FileSpreadsheet size={16}/><span><b>{item.periodStart&&item.periodEnd?`${item.periodStart} – ${item.periodEnd}`:monthLabel(item.month)}</b><small>{item.uploadedByName} · {item.rowCount} cells</small></span><em className={`import-state ${item.status}`}>{item.status.replace('_',' ')}</em></div>)}</div>}
        </section>
      </aside>
    </div>
  </AppShell>;
}

function HistoryPage() {
  const [month,setMonth]=useState(monthNow());
  const [rollback,setRollback]=useState<RosterVersion|null>(null);
  const [selectedVersionId,setSelectedVersionId]=useState('');
  const [editAssignment,setEditAssignment]=useState<ShiftAssignment|null|false>(false);
  const [reason,setReason]=useState('');
  const versions=useListRosterVersions({month});
  const versionSchedule=useGetRosterVersionSchedule(selectedVersionId||'', {
    query:{enabled:!!selectedVersionId,queryKey:getGetRosterVersionScheduleQueryKey(selectedVersionId||'')},
  });
  const employees=useListEmployees({activeOnly:true});
  const shifts=useListShiftTypes();
  const createVersion=useCreateRosterVersion({mutation:{onSuccess:(version)=>{
    setSelectedVersionId(version.id);
    invalidate(getListRosterVersionsQueryKey({month}));
    invalidate(getGetMonthlyScheduleQueryKey({month}));
  }}});
  const publish=usePublishRosterVersion({mutation:{onSuccess:()=>invalidateRosterReads()}});
  const rollbackMutation=useRollbackRosterVersion({mutation:{onSuccess:()=>{invalidateRosterReads();setRollback(null);setReason('');}}});
  const createAssignment=useCreateRosterAssignment({mutation:{onSuccess:()=>{if(selectedVersionId)invalidate(getGetRosterVersionScheduleQueryKey(selectedVersionId));invalidateRosterReads();setEditAssignment(false);}}});
  const updateAssignment=useUpdateRosterAssignment({mutation:{onSuccess:()=>{if(selectedVersionId)invalidate(getGetRosterVersionScheduleQueryKey(selectedVersionId));invalidateRosterReads();setEditAssignment(false);}}});
  const deleteAssignment=useDeleteRosterAssignment({mutation:{onSuccess:()=>{if(selectedVersionId)invalidate(getGetRosterVersionScheduleQueryKey(selectedVersionId));invalidateRosterReads();}}});
  const createDraft=()=>createVersion.mutate({data:{month,copyPublished:true}});
  const assignments=versionSchedule.data?.assignments.filter(a=>a.displayInCalendar)||[];
  const activeVersion=versions.data?.find(v=>v.id===selectedVersionId);
  const saveAssignment=(data:Record<string,string>)=>{
    if(!selectedVersionId)return;
    const payload={date:data.date,employeeId:data.employeeId,shiftTypeId:data.shiftTypeId,notes:data.notes||null};
    if(editAssignment)updateAssignment.mutate({versionId:selectedVersionId,assignmentId:editAssignment.id,data:payload});
    else createAssignment.mutate({versionId:selectedVersionId,data:payload});
  };
  return <AppShell title="Version history"><PageHeading eyebrow="PUBLISH WITH CONFIDENCE" title="Version history" detail="Review published and draft versions. Start an editable copy, preview any version, publish when ready, or restore a prior roster."
    actions={<><MonthPicker month={month} onChange={m=>{setMonth(m);setSelectedVersionId('');}}/><button className="button button-primary" onClick={createDraft} disabled={createVersion.isPending} data-testid="button-create-draft">
      {createVersion.isPending?'Creating draft…':<><Plus size={15}/> New draft</>}</button></>}/>
    {createVersion.isError&&<p className="inline-error">A draft could not be created. The current published roster remains unchanged.</p>}
    {versions.isLoading?<SpinnerBlock/>:versions.isError?<QueryError retry={()=>versions.refetch()}/>:!versions.data?.length?
      <EmptyState title="No roster versions for this month" detail="Confirmed imports create a version that you can review and publish here." action={<Link href="/admin/imports" className="button button-primary">Import a roster <ArrowRight size={15}/></Link>}/>:
      <section className="version-list">{versions.data.map((v,i)=><article className={`version-card ${v.status==='published'?'version-published':''} ${selectedVersionId===v.id?'version-selected':''}`} key={v.id} data-testid={`row-version-${v.id}`}>
        <div className="version-line"><span className={`version-marker ${v.status}`}><i/></span><div className="version-main">
          <div className="version-title"><h2>Version {v.versionNumber}</h2><span className={`status-pill ${v.status==='published'?'status-live':v.status==='draft'?'status-draft':'status-archived'}`}><i/>{v.status}</span></div>
           <p>{v.assignmentCount} working shifts · {v.periodStart} – {v.periodEnd} · Created by {v.createdByName}</p><small>{fmtDate(v.createdAt.slice(0,10),{day:'numeric',month:'long',year:'numeric'})} · {new Intl.DateTimeFormat('en',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Qatar'}).format(new Date(v.createdAt))}</small>
          {v.publishedAt&&<span className="version-published-at"><Check size={13}/> Published {fmtDate(v.publishedAt.slice(0,10),{day:'numeric',month:'short',year:'numeric'})}</span>}
        </div></div><div className="version-actions">
          <button className="button button-secondary button-small" onClick={()=>setSelectedVersionId(v.id)} data-testid={`button-preview-version-${v.id}`}>{selectedVersionId===v.id?'Viewing':'Preview'}</button>
          {v.status==='draft'&&<button className="button button-primary button-small"
            onClick={()=>{if(window.confirm(`Publish version ${v.versionNumber} for ${monthLabel(month)}? This becomes visible to the nursing team.`))publish.mutate({versionId:v.id});}}
            disabled={publish.isPending} data-testid={`button-publish-version-${v.id}`}>{publish.isPending?'Publishing…':'Publish version'}</button>}
          {v.status!=='draft'&&<button className="button button-secondary button-small" onClick={()=>{setRollback(v);setReason('');}} data-testid={`button-rollback-version-${v.id}`}>Restore this version</button>}
        </div>{i<versions.data.length-1&&<span className="version-track"/>}</article>)}</section>}
    {publish.isError&&<p className="inline-error">This version could not be published. Please retry.</p>}
    {selectedVersionId&&<section className="surface version-preview">
      <div className="section-head"><div><div className="eyebrow">VERSION PREVIEW</div><h2>{activeVersion?`Version ${activeVersion.versionNumber}`:'Roster version'} · {monthLabel(month)}</h2>
        <p>{activeVersion?.status==='draft'?'Edit this draft before publishing.':'Read-only historical view.'}</p></div>
        {activeVersion?.status==='draft'&&<button className="button button-primary button-small" onClick={()=>setEditAssignment(null)} data-testid="button-add-version-assignment"><Plus size={14}/> Add shift</button>}
      </div>
      {versionSchedule.isLoading?<SpinnerBlock label="Loading version schedule"/>:versionSchedule.isError?<QueryError message="This version could not be loaded." retry={()=>versionSchedule.refetch()}/>:
        !assignments.length?<EmptyState title="This version has no assignments" detail="Add shifts to this draft or select another roster version."/>:
        <div className="version-assignment-list">{assignments.map(a=><div key={a.id} className="version-assignment">
          <span className="version-assignment-date">{fmtDate(a.date,{weekday:'short',day:'numeric',month:'short'})}</span>
          <ShiftRow assignment={a} admin={activeVersion?.status==='draft'} onEdit={()=>setEditAssignment(a)}
             onDelete={()=>{if(window.confirm(`Remove ${a.employeeName}’s ${a.shiftCode} assignment?`))deleteAssignment.mutate({versionId:selectedVersionId,assignmentId:a.id});}} />
        </div>)}</div>}
    </section>}
    {editAssignment!==false&&<FormModal title={editAssignment?'Edit draft assignment':'Add shift to draft'} description="These changes are saved to the selected draft version."
      fields={[{name:'date',label:'Shift date',type:'date',value:editAssignment?.date||`${month}-01`},
        {name:'employeeId',label:'Employee',type:'select',options:(employees.data||[]).map(e=>({value:e.id,label:`${e.fullName} · ${e.employeeCode}`})),value:editAssignment?.employeeId},
        {name:'shiftTypeId',label:'Shift type',type:'select',options:(shifts.data||[]).filter(s=>s.active).map(s=>({value:s.id,label:`${s.name} · ${s.code}`})),value:editAssignment?.shiftTypeId},
        {name:'notes',label:'Notes (optional)',value:editAssignment?.notes||''}]}
      busy={createAssignment.isPending||updateAssignment.isPending}
      error={createAssignment.isError||updateAssignment.isError?'The assignment could not be saved. Please try again.':undefined}
      onClose={()=>setEditAssignment(false)} onSubmit={saveAssignment} submitLabel="Save assignment"/>}
    {rollback&&<div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true"><header><div><h2>Restore version {rollback.versionNumber}?</h2><p>This creates a new version from the selected roster. It does not erase history.</p></div><button className="icon-button" onClick={()=>setRollback(null)} aria-label="Close"><X size={18}/></button></header>
      <label className="form-field"><span>Reason for restore</span><textarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Add a short note for the audit trail" data-testid="input-rollback-reason"/></label>
      <footer><button className="button button-quiet" onClick={()=>setRollback(null)}>Cancel</button><button className="button button-primary" disabled={reason.trim().length<3||rollbackMutation.isPending}
        onClick={()=>rollbackMutation.mutate({versionId:rollback.id,data:{reason:reason.trim()}})} data-testid="button-confirm-rollback">{rollbackMutation.isPending?'Restoring…':'Restore roster'}</button></footer>
      {rollbackMutation.isError&&<p className="inline-error">Restore failed. The current version is unchanged.</p>}</section></div>}
  </AppShell>;
}

function ActivityPage() {
  const {data:activity,isLoading,isError,refetch}=useGetRecentActivity({limit:50});
  return <AppShell title="Admin activity"><PageHeading eyebrow="AUDIT TRAIL" title="Admin activity" detail="A record of roster changes made by your scheduling team."/>
    <section className="surface activity-full">{isLoading?<SpinnerBlock/>:isError?<QueryError retry={()=>refetch()}/>:!activity?.length?<EmptyState title="No admin actions to show" detail="Imports, changes, and publications will be recorded here."/>:<ActivityList items={activity}/>}</section>
  </AppShell>;
}

function AuthPage({type}:{type:'signin'|'signup'}) {
  return <main className="auth-page"><div className="auth-side"><Link href="/" className="brand-link"><Brand/></Link><div className="auth-message">
    <span className="eyebrow">AMAN NURSING</span><h1>A steady start<br/>to every shift.</h1><p>Sign in to find your published roster and keep your next shift close at hand.</p></div>
    <div className="auth-side-foot"><span>Asia/Qatar · GMT+03:00</span><span>English-first · RTL-ready</span></div></div>
    <div className="auth-form-side"><Link href="/" className="auth-back"><ArrowLeft size={15}/> Back to Aman</Link>
      <div className="auth-brand-mobile"><Brand/></div>{type==='signin'?<SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/>:<SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/>}
    </div></main>;
}

function AuthSwitch() {
  const [,setLocation]=useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance}
    signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{signIn:{start:{title:'Welcome back',subtitle:'Sign in to check your Aman roster'}},signUp:{start:{title:'Join your team',subtitle:'Create your Aman Nursing account'}}}}
    routerPush={to=>setLocation(stripBase(to))} routerReplace={to=>setLocation(stripBase(to),{replace:true})}>
    <QueryClientProvider client={queryClient}><CacheOnUserChange/><HealthMonitor/><Switch>
      <Route path="/"><><Show when="signed-in"><Redirect to="/dashboard"/></Show><Show when="signed-out"><PublicHome/></Show></></Route>
      <Route path="/sign-in/*?" component={()=> <AuthPage type="signin"/>}/>
      <Route path="/sign-up/*?" component={()=> <AuthPage type="signup"/>}/>
      <Route path="/dashboard" component={()=> <SignedInOnly><DashboardPage/></SignedInOnly>}/>
      <Route path="/schedule" component={()=> <SignedInOnly><SchedulePage/></SignedInOnly>}/>
      <Route path="/my-schedule" component={()=> <SignedInOnly><SchedulePage mine/></SignedInOnly>}/>
      <Route path="/admin/employees" component={()=> <SignedInOnly><AdminOnly><DirectoryPage kind="employees"/></AdminOnly></SignedInOnly>}/>
      <Route path="/admin/departments" component={()=> <SignedInOnly><AdminOnly><DirectoryPage kind="departments"/></AdminOnly></SignedInOnly>}/>
      <Route path="/admin/shifts" component={()=> <SignedInOnly><AdminOnly><DirectoryPage kind="shifts"/></AdminOnly></SignedInOnly>}/>
      <Route path="/admin/imports" component={()=> <SignedInOnly><AdminOnly><ImportsPage/></AdminOnly></SignedInOnly>}/>
      <Route path="/admin/history" component={()=> <SignedInOnly><AdminOnly><HistoryPage/></AdminOnly></SignedInOnly>}/>
      <Route path="/admin/activity" component={()=> <SignedInOnly><AdminOnly><ActivityPage/></AdminOnly></SignedInOnly>}/>
      <Route component={NotFound}/>
    </Switch></QueryClientProvider>
  </ClerkProvider>;
}

function CacheOnUserChange() {
  const {addListener}=useClerk();
  const client=useQueryClient();
  useEffect(()=>{let previous:string|null|undefined;return addListener(({user})=>{const id=user?.id??null;if(previous!==undefined&&previous!==id)client.clear();previous=id;});},[addListener,client]);
  return null;
}

function HealthMonitor() {
  useHealthCheck({query:{refetchInterval:60_000, retry:1}});
  return null;
}

function App() {
  if(!clerkPubKey) return <div className="configuration-error"><Brand/><h1>Authentication is not configured</h1><p>Add the Clerk publishable key to this app’s environment before signing in.</p></div>;
  return <ErrorBoundary><TooltipProvider><WouterRouter base={basePath}><AuthSwitch/></WouterRouter><Toaster/></TooltipProvider></ErrorBoundary>;
}

export default App;
