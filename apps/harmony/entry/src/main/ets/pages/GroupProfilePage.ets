import { Companion, GroupMember, GroupProfile } from '../services/workspace';
import { CompanionAvatar, companionPortraitKey } from './CompanionAvatar';
import { PillAction } from './Controls';

class MemberListSource implements IDataSource {
  private rows: GroupMember[] = [];
  private listeners = new Set<DataChangeListener>();

  totalCount(): number { return this.rows.length; }
  getData(index: number): GroupMember { return this.rows[index]; }
  registerDataChangeListener(listener: DataChangeListener): void { this.listeners.add(listener); }
  unregisterDataChangeListener(listener: DataChangeListener): void { this.listeners.delete(listener); }

  replace(members: GroupMember[]): void {
    this.rows = members;
    this.listeners.forEach((listener: DataChangeListener) => listener.onDatasetChange([{ type: DataOperationType.RELOAD }]));
  }
}

@Component
export struct GroupProfilePage {
  @Prop group: Companion = { key: '', id: '', host: '', title: '', avatar: '' };
  @Prop @Watch('filterMembers') profile?: GroupProfile = undefined;
  @Prop loading: boolean = false;
  @State @Watch('filterMembers') private query: string = '';
  load: (member: Companion, visible: () => boolean) => Promise<string> = async () => '';
  retry: () => void = () => {};

  private source = new MemberListSource();
  @State private matchCount: number = 0;

  aboutToAppear(): void { this.filterMembers(); }

  private filterMembers(): void {
    const members = this.profile?.members || [];
    const term = this.query.normalize('NFKC').trim().toLocaleLowerCase();
    const matches = term ? members.filter((m: GroupMember) => m.title.normalize('NFKC').toLocaleLowerCase().includes(term)) : members;
    this.source.replace(matches);
    this.matchCount = matches.length;
  }

  @Builder
  field(label: Resource, value: string) {
    Column({ space: 4 }) {
      Text(label).fontSize(14).fontColor($r('app.color.muted'))
      Text(value).fontSize(16).fontColor($r('app.color.ink')).copyOption(CopyOptions.InApp)
    }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, bottom: 12 })
  }

  @Builder
  member(m: GroupMember) {
    Row({ space: 12 }) {
      CompanionAvatar({ row: m, portraitSize: 38, load: this.load })
      Text(m.title).id('group-member-name').fontSize(16).fontColor($r('app.color.ink')).layoutWeight(1)
      if (m.role === 'owner' || m.role === 'admin' || m.role === 'guest') {
        Text(m.role === 'owner' ? $r('app.string.group_role_owner') : m.role === 'admin' ? $r('app.string.group_role_admin') : $r('app.string.group_role_guest'))
          .fontSize(13).fontColor($r('app.color.muted'))
      }
    }.width('100%').constraintSize({ minHeight: 56 }).padding({ left: 16, right: 16, top: 6, bottom: 6 }).accessibilityGroup(true)
  }

  build() {
    List() {
      ListItem() {
        Row({ space: 12 }) {
          ForEach([this.group], (group: Companion) => {
            CompanionAvatar({ row: group, portraitSize: 48, load: this.load })
          }, (group: Companion) => companionPortraitKey(group))
          Text(this.profile?.title || this.group.title).id('group-profile-name').layoutWeight(1).fontSize(22)
            .fontWeight(FontWeight.Medium).fontColor($r('app.color.ink'))
        }.width('100%').padding(16)
      }
      if (this.profile?.topic) { ListItem() { this.field($r('app.string.group_topic'), this.profile!.topic!) } }
      if (this.profile?.description) { ListItem() { this.field($r('app.string.group_description'), this.profile!.description!) } }
      if (this.profile) {
        ListItem() {
          Text($r('app.string.group_member_count', this.profile.members.length)).id('group-member-count')
            .fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.ink')).padding({ left: 16, right: 16, top: 12, bottom: 8 })
        }
        if (this.profile.members.length) {
          ListItem() {
            Search({ value: this.query, placeholder: $r('app.string.group_member_search') }).id('group-member-search')
              .height(40).cancelButton({ style: CancelButtonStyle.INPUT }).onChange((value: string) => { this.query = value; })
              .margin({ left: 16, right: 16, bottom: 8 })
          }
          if (this.query && this.matchCount === 0) {
            ListItem() {
              Text($r('app.string.group_no_matches')).id('group-no-matches').fontSize(15).fontColor($r('app.color.muted')).padding(16)
            }
          } else {
            LazyForEach(this.source, (member: GroupMember) => {
              ListItem() { this.member(member) }
            }, (member: GroupMember) => JSON.stringify([companionPortraitKey(member), member.role]))
          }
        }
      } else {
        ListItem() {
          Row() {
            if (this.loading) { LoadingProgress().width(32).height(32) }
            else { PillAction({ label: $r('app.string.group_profile_retry'), onTap: this.retry }) }
          }.width('100%').justifyContent(FlexAlign.Center).padding(16)
        }
      }
    }.id('group-profile-list').width('100%').height('100%').scrollBar(BarState.Auto).backgroundColor($r('app.color.canvas'))
  }
}
