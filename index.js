// require('dotenv').config();

const express = require("express");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const crypto = require('crypto');
const app = express();
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const WebSocket = require("ws");
const {MongoClient, ObjectId} = require("mongodb");
// const { parse } = require('path');
const http = require('http');
const cookie = require("cookie");

const clientPromise = new MongoClient(
  "mongodb+srv://gravy:6vXAa62i5Yi0nqlJ@cluster0.ez8mwhg.mongodb.net/?retryWrites=true&w=majority");


clientPromise
  .connect()
  .then(() =>{
    console.log("Connected");
  })
  .catch((err) =>{
    console.error("error connecting", err);
  });

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.use(cookieParser());

app.use(async (req, res, next) => {
  try{
    const client = clientPromise;
    req.db = client.db('timers');
    next();
  } catch (err) {
    next(err);
  }
});

const auth = () => async (req, res, next) => {
  if (!req.cookies['sessionId']) {
    return next()
  }
  const user = await findUserBySessionId(req.db, req.cookies["sessionId"]);
  req.user = user
  req.sessionId = req.cookies["sessionId"]
  next()
}


const hash = (d) => {
  const hashedData = crypto.createHash('sha256').update(d).digest('hex');
  return hashedData;
};



const findUserByUserName = async (db, username) =>
  db.collection("users").findOne({username});

const findUserBySessionId = async (db, sessionId) => {
  const session = await db.collection("sessions").findOne(
    {sessionId},
    {
      projection: {userId: 1},
    }
  );


  if (!session){
    return;
  }

  return db.collection("users")
  .findOne({_id: new ObjectId(session.userId)});
}


const createSession = async (db, userId) =>{
  const sessionId = nanoid();

  await db.collection("sessions").insertOne({
    userId,
    sessionId,
  });

  return sessionId;
}

const deleteSession = async (db, sessionId) => {
  await db.collection("sessions").deleteOne({sessionId});
}

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({clientTracking: false, noServer: true});
const clients  = new Map();


app.post('/login', bodyParser.urlencoded({extended: false}), async (req, res) => {
  const {username, password} = req.body;
  const user = await findUserByUserName(req.db, username);
  if (!user || user.password !== hash(password)) {
    return res.redirect('/?authError=true')
  }
  const sessionId = await createSession(req.db, user._id);
  res.cookie('sessionId', sessionId, {httpOnly: true}).redirect("/");
})

server.on("upgrade", (req, socket, head) => {
  const cookies = cookie.parse(req.headers["cookie"]);
  const token = cookies.sessionId;
  const userId = token;

  if (!userId) {
    socket.write("HTTP/1.1 Unathorized\r\n\r\n")
    socket.destroy();
    return;
  }

  req.userId = userId;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  })
})

wss.on("connection", async (ws, req) => {
  const {userId} = req;
  clients.set(userId, ws);
  sendAllTimers(ws, userId);
  setInterval(() => sendAllTimers(ws, userId), 1000);
  ws.on("close", () =>{
    clients.delete(userId);
  })

  ws.on("message", message => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err){
      return;
    }
  })
})

const sendAllTimers = async (ws, userId) => {
  await clientPromise.connect();
  const db = clientPromise.db('timers');
  ws.send(
    JSON.stringify({
      type: "all_timers",
      activeTimers: await getTimers(userId, true, db),
      oldTimers: await getTimers(userId, false, db),
    })
  )
}

app.post('/signup', bodyParser.urlencoded({extended: false}), async (req, res) => {
  const { username, password } = req.body;
  const existingUser = await findUserByUserName(req.db, username);
  if (existingUser) {
    return res.status(400).send('Имя занято');
  }
  createUser(req.db, username, hash(password));
  res.redirect("/");
});

const createUser = async (db, username, password) => {
  const newUser = await db.collection("users").insertOne({
    username,
    password,
  });

  return newUser;
}
app.get('/logout', auth(), async (req,res) =>{
  if (!req.user){
    return res.redirect('/')
  }
  await deleteSession(req.db, req.sessionId);
  res.clearCookie("sessionId").redirect('/');
})

const getTimers = async (userId, isActive, db) => {
  const timersCollection = await db.collection("timer");
  const {_id} = await findUserBySessionId(db, userId);
  const query = {timerId: _id, isActive: isActive };
  const timers = await timersCollection.find(query).toArray();
  for (const obj of timers){
    obj.progress = Date.now() - obj.start;
  }
  return timers;
};

app.post('/api/timers', auth(), async (req, res) => {
  const { description } = req.body;
  const user = await findUserBySessionId(req.db, req.sessionId);
  const timersCollection = req.db.collection("timer");
  const newTimer = {
    start: Date.now(),
    description,
    isActive: true,
    id: nanoid(),
    timerId: user._id,
  };
  await timersCollection.insertOne(newTimer);
  res.json(newTimer);

});

app.post('/api/timers/:id/stop', auth(), async (req, res) => {
  const { id } = req.params;
  const timersCollection = req.db.collection("timer");
  const timer = await timersCollection.findOne({ id });
  if (timer) {
    const updatedTimer = {
      ...timer,
      isActive: false,
      end: Date.now(),
      duration: Date.now() - timer.start,
    };
    await timersCollection.updateOne({ id }, { $set: updatedTimer });
    // res.json(updatedTimer);
  } else {
    res.status(404).json({ error: "Timer not found" });
  }
});

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError === "true" ? "Wrong username or password" : req.query.authError,
  });
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`  Listening on http://localhost:${port}`);
});
