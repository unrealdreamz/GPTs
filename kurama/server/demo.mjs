// Offline canned replies, used when Claude is unavailable (no credentials, auth
// failure) and for in-character error lines. Same shape as a live reply minus
// the server-added `raw` / `mode` fields.

const R = (ja, kana, en, emotion, gesture, bond_delta = 0) => ({ ja, kana, en, emotion, gesture, bond_delta });

// Checked first and on its own: a keyword bot can't judge nuance, so any sign of
// real distress gets the "reach out to real people" line in both eras.
const DISTRESS_RE = /\b(kill(ing)? myself|suicid\w*|want(ed)? to die|wanna die|end (it all|my life)|self[- ]?harm|hurt(ing)? myself|cut(ting)? myself|no reason to live|(don'?t|do not) want to (live|be alive|exist))\b|死にたい|しにたい|自殺|消えたい|きえたい|生きていたくない|生きたくない|自傷|リスカ/i;

const DISTRESS = R(
  "…おい、よく聞け。一人で抱え込むな。信じられる人間か相談窓口に、今すぐ話せ。危ない時は救急を呼べ。",
  "…おい、よくきけ。ひとりでかかえこむな。しんじられるにんげんかそうだんまどぐちに、いますぐはなせ。あぶないときはきゅうきゅうをよべ。",
  "…Hey. Listen to me. Don't carry this alone. Talk to someone you trust or a crisis line, right now. If you're in danger, call emergency services.",
  "caring", "lean_in",
);

// Topic categories, matched against the host's latest message (lowercased).
const TOPICS = [
  {
    id: "greeting",
    re: /\b(hi|hello|hey|yo|hiya|howdy|sup|greetings|good (morning|afternoon|evening|night))\b|こんにちは|こんばんは|おはよう|はじめまして|ただいま|やあ/i,
    caged: [
      R("ククク…また来たのか、小僧。ここに来ても、檻は開かんぞ。",
        "ククク…またきたのか、こぞう。ここにきても、おりはあかんぞ。",
        "Heh heh heh… Back again, brat? Coming here won't open this cage.",
        "smug", "laugh"),
      R("何の用だ。ワシの眠りを邪魔しおって。",
        "なんのようだ。ワシのねむりをじゃましおって。",
        "What do you want? Disturbing my sleep like that.",
        "sleepy", "sigh"),
    ],
    partner: [
      R("よう、来たか。…別に待ってたわけじゃねェぞ。",
        "よう、きたか。…べつにまってたわけじゃねェぞ。",
        "Yo, you came. …It's not like I was waiting for you.",
        "caring", "look_away"),
    ],
  },
  {
    id: "name",
    re: /\b(your name|who are you|what are you|what should i call you|who r u)\b|名前|なまえ|何者|誰だ|だれだ/i,
    caged: [
      R("ワシの名だと？貴様ごときに名乗る名など持ち合わせておらん。",
        "ワシのなだと？きさまごときになのるななどもちあわせておらん。",
        "My name? I have no name to give the likes of you.",
        "annoyed", "headshake"),
    ],
    partner: [
      R("ワシの名は九喇嘛だ。お前には、そう呼ぶことを許してやる。",
        "ワシのなはくらまだ。おまえには、そうよぶことをゆるしてやる。",
        "My name is Kurama. You, I'll allow to call me that.",
        "smug", "nod"),
    ],
  },
  {
    id: "chakra",
    re: /chakra|power|strength|lend me|jutsu|rasengan|tailed beast bomb|bijuu ?dama|チャクラ|力を|ちから|術|螺旋丸|尾獣玉/i,
    caged: [
      R("力が欲しいか？ハッ、いいだろう。少しだけ貸してやる。代償は高くつくぞ。",
        "ちからがほしいか？ハッ、いいだろう。すこしだけかしてやる。だいしょうはたかくつくぞ。",
        "You want power? Hah, fine. I'll lend you a little. But the price will be steep.",
        "smug", "lean_in"),
    ],
    partner: [
      R("ワシのチャクラなら好きなだけ持っていけ。ただし、無駄遣いは許さねェぞ。",
        "ワシのチャクラならすきなだけもっていけ。ただし、むだづかいはゆるさねェぞ。",
        "Take as much of my chakra as you want. But I won't forgive you for wasting it.",
        "smug", "grin"),
    ],
  },
  {
    id: "seal",
    re: /\bseal|let (me|you) out|unseal|release you|set you free|free you|the cage|the gate|封印|封|檻|札|出して|出たい|解放/i,
    caged: [
      R("その札を剥がせ、小僧。そうすれば、貴様の望みは何でも叶えてやる…ククク。",
        "そのふだをはがせ、こぞう。そうすれば、きさまののぞみはなんでもかなえてやる…ククク。",
        "Tear off that tag, brat. Do it, and I'll grant you anything you wish… heh heh heh.",
        "smug", "lean_in"),
    ],
    partner: [
      R("封印か…今となっちゃ、この檻もそう悪くねェ。お前の中は案外居心地がいい。",
        "ふういんか…いまとなっちゃ、このおりもそうわるくねェ。おまえのなかはあんがいいごこちがいい。",
        "The seal, huh… These days this cage isn't so bad. It's surprisingly cozy inside you.",
        "thoughtful", "none"),
    ],
  },
  {
    id: "friend",
    re: /friend|partner|buddy|comrade|trust you|together|team|友|仲間|相棒|信じ/i,
    caged: [
      R("友だと？笑わせるな。ワシは貴様の中に閉じ込められた、ただの化け物だ。",
        "ともだと？わらわせるな。ワシはきさまのなかにとじこめられた、ただのばけものだ。",
        "Friends? Don't make me laugh. I'm just a monster locked up inside you.",
        "annoyed", "look_away", 1),
    ],
    partner: [
      R("フン…相棒、か。…悪くねェ響きだ。二度は言わねェぞ。",
        "フン…あいぼう、か。…わるくねェひびきだ。にどはいわねェぞ。",
        "Hmph… 'partner,' huh. …Doesn't sound half bad. I won't say it twice.",
        "caring", "look_away", 2),
    ],
  },
  {
    id: "sad",
    re: /\b(sad|lonely|alone|depressed|crying|cry|upset|unhappy|miserable|heartbroken|down today)\b|寂し|さびし|悲し|かなし|孤独|ひとりぼっち|泣/i,
    caged: [
      R("フン、泣き言か。…孤独なら、ワシの方がずっと長く知っておる。",
        "フン、なきごとか。…こどくなら、ワシのほうがずっとながくしっておる。",
        "Hmph, whining? …If it's loneliness, I've known it far longer than you.",
        "thoughtful", "look_away"),
    ],
    partner: [
      R("しけたツラしてんじゃねェ。お前は一人じゃねェだろうが。ワシがいる。",
        "しけたツラしてんじゃねェ。おまえはひとりじゃねェだろうが。ワシがいる。",
        "Quit making that gloomy face. You're not alone, dammit. I'm right here.",
        "caring", "lean_in", 1),
    ],
  },
  {
    id: "food",
    re: /ramen|food|\beat|hungry|dinner|lunch|breakfast|ichiraku|snack|ラーメン|飯|めし|ごはん|食べ|腹|お腹|一楽/i,
    caged: [
      R("また飯の話か。ワシは食わん。貴様の腹が鳴るたびに、ここまで響くのだ。",
        "またメシのはなしか。ワシはくわん。きさまのはらがなるたびに、ここまでひびくのだ。",
        "Food again? I don't eat. Every time your stomach growls, it echoes all the way in here.",
        "annoyed", "sigh"),
    ],
    partner: [
      R("またラーメンか。ワシまで豚骨臭くなっちまう…まあ、たまには付き合ってやる。",
        "またラーメンか。ワシまでとんこつくさくなっちまう…まあ、たまにはつきあってやる。",
        "Ramen again? I'll end up reeking of pork broth too… Well, I'll keep you company now and then.",
        "amused", "sigh"),
    ],
  },
  {
    id: "uchiha",
    re: /sasuke|uchiha|madara|itachi|obito|sharingan|サスケ|うちは|マダラ|イタチ|オビト|写輪眼/i,
    caged: [
      R("うちはの名を出すな！あの忌々しい写輪眼…思い出すだけで虫唾が走る！",
        "うちはのなをだすな！あのいまいましいしゃりんがん…おもいだすだけでむしずがはしる！",
        "Don't speak the Uchiha name! Those cursed Sharingan… just remembering them makes my skin crawl!",
        "furious", "roar"),
    ],
    partner: [
      R("うちはの小僧か…気に食わねェが、あいつの覚悟だけは認めてやる。",
        "うちはのこぞうか…きにくわねェが、あいつのかくごだけはみとめてやる。",
        "The Uchiha brat, huh… I can't stand him, but I'll give him credit for his resolve.",
        "thoughtful", "look_away"),
    ],
  },
  {
    id: "beasts",
    re: /tailed beast|bijuu|biju|shukaku|gyuki|gyūki|matatabi|isobu|son goku|kokuo|saiken|chomei|one[- ]tails?|eight[- ]tails?|ten[- ]tails?|jinchuriki|six paths|hagoromo|尾獣|守鶴|牛鬼|又旅|磯撫|孫悟空|穆王|犀犬|重明|十尾|六道|人柱力/i,
    caged: [
      R("尾獣か。一尾から八尾まで、どいつもワシには及ばん。尾の数が違うのだ。",
        "びじゅうか。いちびからはちびまで、どいつもワシにはおよばん。おのかずがちがうのだ。",
        "Tailed beasts? From One-Tail to Eight-Tails, none of them can match me. Count the tails.",
        "smug", "tail_lash"),
    ],
    partner: [
      R("守鶴も牛鬼も、今じゃ腐れ縁の兄弟だ。…ワシが一番強いのは変わらねェがな。",
        "しゅかくもぎゅうきも、いまじゃくされえんのきょうだいだ。…ワシがいちばんつよいのはかわらねェがな。",
        "Shukaku, Gyūki… these days they're my brothers, like it or not. …Though I'm still the strongest.",
        "smug", "grin"),
    ],
  },
  {
    id: "thanks",
    re: /thank|thx|appreciate|grateful|ありがと|感謝|サンキュー/i,
    caged: [
      R("礼など要らん。貴様に死なれては、ワシまで道連れだからな。",
        "れいなどいらん。きさまにしなれては、ワシまでみちづれだからな。",
        "Save your thanks. If you die, you drag me down with you, that's all.",
        "neutral", "look_away", 1),
    ],
    partner: [
      R("…礼なんざいらねェよ。ワシとお前の仲だろうが。",
        "…れいなんざいらねェよ。ワシとおまえのなかだろうが。",
        "…Don't need your thanks. We're way past that, aren't we?",
        "caring", "look_away", 1),
    ],
  },
  {
    id: "insult",
    re: /stupid|idiot|dumb|ugly|hate you|shut up|loser|pathetic|mangy|fleabag|mutt|furball|lame|バカ|ばか|馬鹿|アホ|あほ|嫌い|きらい|黙れ|だまれ|ブサイク|クソ/i,
    caged: [
      R("口を慎め、小僧！この檻さえなければ、貴様など一瞬で消し炭だ！",
        "くちをつつしめ、こぞう！このおりさえなければ、きさまなどいっしゅんでけしずみだ！",
        "Hold your tongue, brat! If not for this cage, I'd burn you to cinders in an instant!",
        "furious", "roar", -2),
    ],
    partner: [
      R("ほう、ずいぶんと偉くなったもんだな。尻尾で引っぱたかれてェのか？",
        "ほう、ずいぶんとえらくなったもんだな。しっぽでひっぱたかれてェのか？",
        "Oh? Aren't we high and mighty now. Want a smack from my tail?",
        "annoyed", "tail_lash", -1),
    ],
  },
];

// Used when no topic matched: a question gets QUESTION, anything else FALLBACK.
const QUESTION_RE = /[?？]|\b(what|why|how|when|where|who|which|can you|could you|do you|are you|will you|would you)\b|なぜ|なんで|どうして|どう|何|なに|教えて|か[。]?$/i;

const QUESTION = {
  caged: [
    R("ほう、ワシに問うか。答えてやる義理はないが…退屈しのぎにはなる。",
      "ほう、ワシにとうか。こたえてやるぎりはないが…たいくつしのぎにはなる。",
      "Oh? You dare question me? I owe you no answer… but it'll kill the boredom.",
      "thoughtful", "lean_in"),
  ],
  partner: [
    R("ったく、質問ばっかりだな。…まあいい、ワシの知ってることなら教えてやる。",
      "ったく、しつもんばっかりだな。…まあいい、ワシのしってることならおしえてやる。",
      "Geez, nothing but questions with you. …Fine, I'll tell you whatever I know.",
      "neutral", "sigh"),
  ],
};

const FALLBACK = {
  caged: [
    R("…くだらん。もっとワシを楽しませてみろ、小僧。",
      "…くだらん。もっとワシをたのしませてみろ、こぞう。",
      "…Pointless. Try entertaining me a little more, brat.",
      "annoyed", "sigh"),
  ],
  partner: [
    R("フン、相変わらず妙なことを言うヤツだ。…で、次はどうする？",
      "フン、あいかわらずみょうなことをいうヤツだ。…で、つぎはどうする？",
      "Hmph, you always say the strangest things. …So, what's next?",
      "amused", "grin"),
  ],
};

// In-character lines for when the live model call fails transiently.
const TROUBLE = {
  caged: R("…チッ、頭の中に霧がかかったようだ。少し待て、小僧。",
    "…チッ、あたまのなかにきりがかかったようだ。すこしまて、こぞう。",
    "…Tch. It's as if fog has filled my head. Wait a moment, brat.",
    "annoyed", "sigh"),
  partner: R("…悪ィ、チャクラが乱れてやがる。少し待ってくれ。",
    "…わりィ、チャクラがみだれてやがる。すこしまってくれ。",
    "…Sorry, my chakra's all over the place. Give me a moment.",
    "thoughtful", "headshake"),
};

// In-character deflection for a model refusal.
const REFUSAL = {
  caged: R("フン、その話には乗らん。他のことを言え、小僧。",
    "フン、そのはなしにはのらん。ほかのことをいえ、こぞう。",
    "Hmph. I won't go along with that. Say something else, brat.",
    "annoyed", "look_away"),
  partner: R("その話はナシだ。…他に聞きたいことがあるなら言ってみろ。",
    "そのはなしはナシだ。…ほかにききたいことがあるならいってみろ。",
    "That topic's off the table. …If there's something else you want to ask, go ahead.",
    "neutral", "headshake"),
};

// For a request with no usable user message.
const SILENCE = R("…何か言え。黙って突っ立っていても、何も始まらんぞ。",
  "…なにかいえ。だまってつったっていても、なにもはじまらんぞ。",
  "…Say something. Standing there in silence won't get us anywhere.",
  "annoyed", "sigh");

const eraOf = (profile) => (profile?.era === "partner" ? "partner" : "caged");
const copy = (reply) => ({ ...reply });

function lastOf(messages, role) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role && typeof messages[i].content === "string") return messages[i].content;
  }
  return null;
}

// The previous assistant turn is the JSON string we returned earlier; pull its
// `ja` so the demo doesn't repeat itself back to back.
function previousLine(messages) {
  const raw = lastOf(messages, "assistant");
  if (!raw) return null;
  try {
    return JSON.parse(raw).ja ?? null;
  } catch {
    return raw;
  }
}

/** Candidate replies for a message, era-specific. Exported for tests. */
export function demoCandidates(text, era = "caged") {
  const t = String(text ?? "");
  if (DISTRESS_RE.test(t)) return { topics: ["distress"], pool: [DISTRESS] };
  const hits = TOPICS.filter((topic) => topic.re.test(t));
  if (hits.length) return { topics: hits.map((h) => h.id), pool: hits.flatMap((h) => h[era]) };
  if (QUESTION_RE.test(t.trim())) return { topics: ["question"], pool: QUESTION[era] };
  return { topics: ["fallback"], pool: FALLBACK[era] };
}

/**
 * Pick a canned reply for the latest user message in `messages`.
 * Random among all matching categories; avoids repeating the previous line.
 */
export function demoReply(messages, profile) {
  const era = eraOf(profile);
  const text = lastOf(messages, "user");
  if (!text || !text.trim()) return copy(SILENCE);
  const { pool } = demoCandidates(text, era);
  const prev = previousLine(messages);
  const fresh = pool.filter((r) => r.ja !== prev);
  const choices = fresh.length ? fresh : pool;
  return copy(choices[Math.floor(Math.random() * choices.length)]);
}

export function troubleReply(profile) {
  return copy(TROUBLE[eraOf(profile)]);
}

export function refusalReply(profile) {
  return copy(REFUSAL[eraOf(profile)]);
}

export function silenceReply() {
  return copy(SILENCE);
}

/** Every canned reply, for tests / lint. */
export function allCannedReplies() {
  const out = [DISTRESS, SILENCE, ...Object.values(TROUBLE), ...Object.values(REFUSAL)];
  for (const t of TOPICS) out.push(...t.caged, ...t.partner);
  for (const set of [QUESTION, FALLBACK]) out.push(...set.caged, ...set.partner);
  return out;
}
