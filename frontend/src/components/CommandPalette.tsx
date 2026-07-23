import { useNavigate } from 'react-router-dom';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { SCREEN_ROUTES } from '../utils/screenRoutes';
import { DASHBOARD_ITEM, NAV_SECTIONS } from '../utils/navSections';
import { useSharedStudentSelection } from '../hooks/useSharedStudentSelection';
import type { Student } from '../api/client';

// Global Ctrl/Cmd+K palette — ports the legacy openCommandPalette. Two
// sources: the nav menu (respecting admin-only visibility) and a student
// search that jumps to that student's profile. Search is delegated to
// cmdk's built-in matcher via each item's `value`, so menu items match on
// their label + group and students on name/nickname/id.
export default function CommandPalette({
  isAdmin,
  students,
  open,
  onOpenChange,
}: {
  isAdmin: boolean;
  students: Student[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [, setSelectedStudent] = useSharedStudentSelection();

  const goScreen = (screen: string) => {
    onOpenChange(false);
    navigate(SCREEN_ROUTES[screen] || '/');
  };

  const goStudent = (id: string) => {
    onOpenChange(false);
    setSelectedStudent(id);
    navigate(SCREEN_ROUTES.check);
  };

  const menuItems = [
    { screen: DASHBOARD_ITEM.screen, label: DASHBOARD_ITEM.label, group: 'เมนู', icon: DASHBOARD_ITEM.icon },
    ...NAV_SECTIONS.filter((section) => !section.adminOnly || isAdmin).flatMap((section) =>
      section.items
        .filter((item) => !item.adminOnly || isAdmin)
        .map((item) => ({ screen: item.screen, label: item.label, group: section.label, icon: item.icon })),
    ),
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="ค้นหา" description="ค้นหาเมนูหรือนักเรียน">
      <Command>
        <CommandInput placeholder="ค้นหาเมนู หรือชื่อ/รหัสนักเรียน..." />
        <CommandList>
          <CommandEmpty>ไม่พบผลลัพธ์ที่ตรงกับคำค้นหา</CommandEmpty>
          <CommandGroup heading="เมนู">
            {menuItems.map((item) => (
              <CommandItem
                key={item.screen}
                value={`${item.label} ${item.group}`}
                onSelect={() => goScreen(item.screen)}
              >
                <i className={`fas ${item.icon}`} style={{ width: 16, textAlign: 'center' }}></i>
                <span>{item.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">{item.group}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {students.length > 0 && (
            <CommandGroup heading="นักเรียน">
              {students.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`${s.name} ${s.nickname || ''} ${s.id}`}
                  onSelect={() => goStudent(s.id)}
                >
                  <i className="far fa-user" style={{ width: 16, textAlign: 'center' }}></i>
                  <span>
                    {s.name}
                    {s.nickname ? ` (${s.nickname})` : ''}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.id}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
