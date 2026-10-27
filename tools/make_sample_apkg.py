import sqlite3, json, zipfile, time, hashlib, math, struct, io, os, random
random.seed(7)
now=int(time.time())
import pathlib; ROOT=pathlib.Path(__file__).resolve().parent.parent; os.makedirs(ROOT/'tools/.build',exist_ok=True); os.chdir(ROOT/'tools/.build'); DB='collection.anki21'
if os.path.exists(DB): os.remove(DB)
c=sqlite3.connect(DB)
c.executescript('''
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
''')
CSS=""".card {\n font-family: arial;\n font-size: 20px;\n text-align: center;\n color: black;\n background-color: white;\n}\n.note {\n display: block;\n margin-top: .7em;\n font-size: .6em;\n line-height: 1.45;\n color: var(--text-muted, #666);\n}\n.extra {\n margin-top: 1em;\n font-size: .7em;\n line-height: 1.45;\n color: var(--text-muted, #666);\n}\n"""
CLOZE_CSS=CSS+".cloze {\n font-weight: bold;\n color: blue;\n}\n.nightMode .cloze {\n color: lightblue;\n}\n"
M_BASIC=1700000000001; M_REV=1700000000002; M_CLOZE=1700000000003
def tmpl(name,ord,q,a): return {"name":name,"ord":ord,"qfmt":q,"afmt":a,"did":None,"bqfmt":"","bafmt":""}
def fld(name,ord): return {"name":name,"ord":ord,"sticky":False,"rtl":False,"font":"Arial","size":20}
models={
 str(M_BASIC):{"id":M_BASIC,"name":"Базовая","type":0,"css":CSS,"flds":[fld("Лицо",0),fld("Оборот",1)],
   "tmpls":[tmpl("Карточка 1",0,"{{Лицо}}","{{FrontSide}}\n\n<hr id=answer>\n\n{{Оборот}}")],"sortf":0,"did":1,"mod":now,"usn":-1,"req":[[0,"any",[0]]],"latexPre":"","latexPost":"","tags":[],"vers":[]},
 str(M_REV):{"id":M_REV,"name":"Базовая (и обратная)","type":0,"css":CSS,"flds":[fld("Лицо",0),fld("Оборот",1)],
   "tmpls":[tmpl("Карточка 1",0,"{{Лицо}}","{{FrontSide}}\n\n<hr id=answer>\n\n{{Оборот}}"),tmpl("Карточка 2",1,"{{Оборот}}","{{FrontSide}}\n\n<hr id=answer>\n\n{{Лицо}}")],"sortf":0,"did":1,"mod":now,"usn":-1,"req":[[0,"any",[0]],[1,"any",[1]]],"latexPre":"","latexPost":"","tags":[],"vers":[]},
 str(M_CLOZE):{"id":M_CLOZE,"name":"Пропуски","type":1,"css":CLOZE_CSS,"flds":[fld("Текст",0),fld("Дополнение",1)],
   "tmpls":[tmpl("Пропуск",0,"{{cloze:Текст}}","{{cloze:Текст}}<br>\n{{#Дополнение}}<div class=extra>{{Дополнение}}</div>{{/Дополнение}}")],"sortf":0,"did":1,"mod":now,"usn":-1,"latexPre":"","latexPost":"","tags":[],"vers":[]},
}
D={}
def deck(id,name): D[str(id)]={"id":id,"name":name,"mod":now,"usn":-1,"collapsed":False,"dyn":0,"conf":1,"desc":"","newToday":[0,0],"revToday":[0,0],"lrnToday":[0,0],"timeToday":[0,0]}
deck(1,"Default")
DK={"const":1700000001001,"ed":1700000001002,"thermo":1700000001003,"osc":1700000001004,"math":1700000001005}
deck(1700000001000,"Физфак: выживание")
deck(DK["const"],"Физфак: выживание::Константы")
deck(DK["ed"],"Физфак: выживание::Электродинамика")
deck(DK["thermo"],"Физфак: выживание::Термодинамика")
deck(DK["osc"],"Физфак: выживание::Колебания")
deck(DK["math"],"Физфак: выживание::Матан")
c.execute("insert into col values (1,?,?,?,11,0,0,0,?,?,?,?,?)",(now,now*1000,now*1000,json.dumps({}),json.dumps(models,ensure_ascii=False),json.dumps(D,ensure_ascii=False),json.dumps({}),json.dumps({})))
nid=1700000100000; cid=1700000200000; due=0
import re
def add(mid,did,fields,tags=""):
  global nid,cid,due
  nid+=1
  m=models[str(mid)]
  flds="\x1f".join(fields)
  c.execute("insert into notes values (?,?,?,?,?,?,?,?,?,?,?)",(nid,hashlib.md5(str(nid).encode()).hexdigest()[:10],mid,now,-1," "+tags+" " if tags else "",flds,re.sub('<[^>]+>','',fields[0])[:50],0,0,""))
  if m["type"]==1:
    ords=sorted(set(int(x) for x in re.findall(r"\{\{c(\d+)::",fields[0])))
    ords=[o-1 for o in ords]
  else:
    ords=[t["ord"] for t in m["tmpls"]]
  for o in ords:
    cid+=1; due+=1
    c.execute("insert into cards values (?,?,?,?,?,?,0,0,?,0,0,0,0,0,0,0,0,'')",(cid,nid,did,o,now,-1,due))

B=M_BASIC; R=M_REV; Z=M_CLOZE
# Константы
add(B,DK["const"],["Постоянная Планка","\\(h = 6{,}626 \\cdot 10^{-34}\\) Дж·с<br><span class=note>Приведённая: \\(\\hbar = h/2\\pi\\)</span>"],"константы")
add(B,DK["const"],["Скорость света в вакууме","\\(c = 299\\,792\\,458\\) м/с<br><span class=note>Точно, по определению метра</span>"],"константы")
add(B,DK["const"],["Постоянная Больцмана","\\(k_B = 1{,}381 \\cdot 10^{-23}\\) Дж/К"],"константы")
add(B,DK["const"],["Элементарный заряд","\\(e = 1{,}602 \\cdot 10^{-19}\\) Кл"],"константы")
add(B,DK["const"],["Гравитационная постоянная","\\(G = 6{,}674 \\cdot 10^{-11}\\) м³/(кг·с²)"],"константы")
add(B,DK["const"],["Число Авогадро","\\(N_A = 6{,}022 \\cdot 10^{23}\\) моль⁻¹"],"константы")
add(B,DK["const"],["Постоянная тонкой структуры","\\(\\alpha = \\dfrac{e^2}{4\\pi\\varepsilon_0 \\hbar c} \\approx \\dfrac{1}{137}\\)"],"константы")
# Электродинамика (и обратная)
add(R,DK["ed"],["Закон Гаусса в дифференциальной форме","\\[\\nabla\\cdot\\mathbf E = \\frac{\\rho}{\\varepsilon_0}\\]"],"максвелл")
add(R,DK["ed"],["Отсутствие магнитных зарядов","\\[\\nabla\\cdot\\mathbf B = 0\\]"],"максвелл")
add(R,DK["ed"],["Закон электромагнитной индукции Фарадея","\\[\\nabla\\times\\mathbf E = -\\frac{\\partial \\mathbf B}{\\partial t}\\]"],"максвелл")
add(R,DK["ed"],["Закон Ампера — Максвелла","\\[\\nabla\\times\\mathbf B = \\mu_0\\mathbf j + \\mu_0\\varepsilon_0\\frac{\\partial \\mathbf E}{\\partial t}\\]"],"максвелл")
add(R,DK["ed"],["Сила Лоренца","\\[\\mathbf F = q\\left(\\mathbf E + \\mathbf v\\times\\mathbf B\\right)\\]"])
# Термодинамика
add(Z,DK["thermo"],["Первое начало термодинамики: {{c1::\\(\\delta Q = dU + \\delta A\\)}}","Теплота идёт на изменение внутренней энергии и на работу системы."],"начала")
add(Z,DK["thermo"],["Энтропия изолированной системы {{c1::не убывает}} — это {{c2::второе}} начало термодинамики.",""],"начала")
add(Z,DK["thermo"],["КПД цикла Карно: {{c1::\\(\\eta = 1 - T_\\text{х} / T_\\text{н}\\)}}","Больше не бывает. Даже перед сессией."])
add(Z,DK["thermo"],["При {{c1::адиабатном::какой процесс?}} процессе нет теплообмена с окружающей средой.",""])
add(Z,DK["thermo"],["При \\(T \\to 0\\) энтропия стремится к {{c1::постоянной}} — теорема {{c2::Нернста}}.","Третье начало термодинамики."],"начала")
add(B,DK["thermo"],["Что остаётся постоянным в изопроцессах идеального газа?",
 "<table><tr><th>Процесс</th><th>Постоянны</th></tr>"
 "<tr><td>Изотермический</td><td>\\(T,\\ pV\\)</td></tr>"
 "<tr><td>Изобарный</td><td>\\(p,\\ V/T\\)</td></tr>"
 "<tr><td>Изохорный</td><td>\\(V,\\ p/T\\)</td></tr>"
 "<tr><td>Адиабатный</td><td>\\(S,\\ pV^\\gamma\\)</td></tr></table>"],"таблица")
# Колебания
add(B,DK["osc"],["Что изображено на графике?<br><img src=\"zatuhanie.svg\">","Затухающие колебания:<br>\\(x(t) = A_0\\, e^{-\\beta t}\\cos(\\omega t + \\varphi)\\)"])
add(B,DK["osc"],["Период малых колебаний математического маятника","\\(T = 2\\pi\\sqrt{\\dfrac{l}{g}}\\)<br><img src=\"mayatnik.svg\">"])
add(B,DK["osc"],["Что за нота? [sound:la-440.wav]","Ля первой октавы, 440 Гц — стандарт настройки"],"звук")
add(B,DK["osc"],["Резонанс","Резкий рост амплитуды вынужденных колебаний, когда частота внешней силы приближается к собственной частоте системы."])
# Матан
add(B,DK["math"],["\\(\\displaystyle\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx\\)","\\(\\sqrt{\\pi}\\)<br><span class=note>Интеграл Пуассона: возводим в квадрат и переходим в полярные координаты</span>"])
add(B,DK["math"],["Формула Эйлера","\\(e^{i\\varphi} = \\cos\\varphi + i\\sin\\varphi\\)"])
add(B,DK["math"],["Ряд Тейлора для \\(\\sin x\\)","\\(\\sin x = x - \\dfrac{x^3}{3!} + \\dfrac{x^5}{5!} - \\dots\\)"])
add(B,DK["math"],["Сформулируйте теорему Стокса и объясните её смысл",
 "Циркуляция векторного поля по замкнутому контуру равна потоку его ротора через любую поверхность, натянутую на этот контур:"
 "\\[\\oint_{\\partial S} \\mathbf F\\cdot d\\mathbf l = \\iint_S (\\nabla\\times\\mathbf F)\\cdot d\\mathbf S\\]"
 "Смысл: ротор измеряет «закрученность» поля в каждой точке. Если сложить все маленькие вихри внутри поверхности, внутренние вклады взаимно сократятся, и останется только то, что происходит на границе. Отсюда, например, интегральная форма закона Фарадея получается из дифференциальной в одну строчку."])
c.commit(); c.close()

# media
os.makedirs('media',exist_ok=True)
w,h=560,240
pts=[]
for i in range(0,w-40,3):
  t=i/(w-40)*10
  y=math.exp(-0.28*t)*math.cos(2*math.pi*0.62*t)
  pts.append(f"{20+i:.1f},{h/2-y*95:.1f}")
env1=" ".join(f"{20+i:.1f},{h/2-math.exp(-0.28*(i/(w-40)*10))*95:.1f}" for i in range(0,w-40,12))
env2=" ".join(f"{20+i:.1f},{h/2+math.exp(-0.28*(i/(w-40)*10))*95:.1f}" for i in range(0,w-40,12))
svg1=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}"><rect width="{w}" height="{h}" fill="#f0eee6"/><line x1="20" y1="{h/2}" x2="{w-16}" y2="{h/2}" stroke="#b0aea5" stroke-width="1"/><line x1="20" y1="14" x2="20" y2="{h-14}" stroke="#b0aea5" stroke-width="1"/><polyline points="{env1}" fill="none" stroke="#87867f" stroke-width="1.2" stroke-dasharray="4 4"/><polyline points="{env2}" fill="none" stroke="#87867f" stroke-width="1.2" stroke-dasharray="4 4"/><polyline points="{' '.join(pts)}" fill="none" stroke="#141413" stroke-width="2.2" stroke-linejoin="round"/></svg>'''
open('media/zatuhanie.svg','w').write(svg1)
svg2='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 260" width="300" height="260"><rect width="300" height="260" fill="#f0eee6"/><line x1="60" y1="24" x2="240" y2="24" stroke="#141413" stroke-width="3"/><g stroke="#141413" stroke-width="1.5">'''+"".join(f'<line x1="{x}" y1="24" x2="{x-10}" y2="14"/>' for x in range(70,241,14))+'''</g><line x1="150" y1="24" x2="150" y2="214" stroke="#b0aea5" stroke-width="1" stroke-dasharray="5 5"/><line x1="150" y1="24" x2="212" y2="198" stroke="#141413" stroke-width="2"/><circle cx="212" cy="198" r="16" fill="#141413"/><path d="M150 84 A60 60 0 0 0 170 81" fill="none" stroke="#87867f" stroke-width="1.5"/><text x="186" y="112" font-family="Georgia, serif" font-size="20" fill="#141413" font-style="italic">l</text><text x="154" y="76" font-family="Georgia, serif" font-size="16" fill="#5e5d59" font-style="italic">φ</text><text x="236" y="204" font-family="Georgia, serif" font-size="20" fill="#141413" font-style="italic">m</text></svg>'''
open('media/mayatnik.svg','w').write(svg2)
# wav 440Hz 1.2s, 8kHz 8-bit with fade
sr=8000; n=int(sr*1.2)
frames=bytearray()
for i in range(n):
  env=min(1,i/400)*min(1,(n-i)/1600)
  frames.append(int(128+90*env*math.sin(2*math.pi*440*i/sr)))
buf=io.BytesIO()
buf.write(b'RIFF'+struct.pack('<I',36+len(frames))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,sr,sr,1,8)+b'data'+struct.pack('<I',len(frames))+frames)
open('media/la-440.wav','wb').write(buf.getvalue())
names=['zatuhanie.svg','mayatnik.svg','la-440.wav']
with zipfile.ZipFile(str(ROOT/'samples/fizfak-vyzhivanie.apkg'),'w',zipfile.ZIP_DEFLATED) as z:
  z.write(DB,'collection.anki21')
  z.write(DB,'collection.anki2')
  z.writestr('media',json.dumps({str(i):n for i,n in enumerate(names)}))
  for i,n in enumerate(names): z.write('media/'+n,str(i))
print('ok', os.path.getsize(str(ROOT/'samples/fizfak-vyzhivanie.apkg')))
