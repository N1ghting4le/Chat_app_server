const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const util = require('util');
const cors = require('cors');
const multer = require('multer');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, __dirname + '/socialMedia/images');
    },
    filename: (req, file, cb) => {
        cb(null, `${req.body.login || req.params['login']}${file.originalname.slice(file.originalname.indexOf('.'))}`);
    }
});

const setAgeString = (age) => {
    if ((age >= 10 && age <= 20) || age % 10 >= 5) {
        return 'лет';
    } else if (age % 10 >= 2 && age % 10 <= 4) {
        return 'года';
    } else if (age) {
        return 'год';
    } else return '';
}

const scryptHash = async (string, salt) => {
    const saltInUse = salt || crypto.randomBytes(16).toString('hex');
    const hashBuffer = await util.promisify(crypto.scrypt)(string, saltInUse, 32);
    return `${hashBuffer.toString('hex')}:${saltInUse}`;
}

const scryptVerify = async (testString, hashAndSalt) => {
    const [, salt] = hashAndSalt.split(':');
    return await scryptHash(testString, salt) === hashAndSalt; 
}

const encrypt = (string, algorithm, key) => {
    const iv = crypto.randomBytes(8).toString('hex');
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(string, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${encrypted}:${iv}`;
}

const decrypt = (string, algorithm, key) => {
    const [encryptedString, iv] = string.split(':');
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedString, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

const createKey = (id) => {
    const key = crypto.randomBytes(16).toString('hex');
    keys.keys.push({id, key});
    fs.writeFile(__dirname + '/socialMedia/keys.json', JSON.stringify(keys), () => {});
}

const upload = multer({ storage });
const app = express();

app.use(express.static(__dirname + '/socialMedia/images'));
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

let db = {
    users: [],
    chats: []
};

let keys = {
    keys: []
}

const getData = () => {
    fs.readFile(__dirname + '/socialMedia/db.json', (err, data) => {
        if (err) throw new Error(err);
        db = JSON.parse(data);
    });
    fs.readFile(__dirname + '/socialMedia/keys.json', (err, data) => {
        if (err) throw new Error(err);
        keys = JSON.parse(data);
    });
}
getData();

const writeDB = () => {
    const users = db.users.map(user => ({...user, currentChat: '', res: '', online: '', typing: ''}));
    fs.writeFile(__dirname + '/socialMedia/db.json', JSON.stringify({users, chats: db.chats}), () => {});
}

const switchOnline = (req, res, online) => {
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, online} : user);
    const chats = db.chats.filter(chat => chat.users.includes(req.params['login']));
    chats.forEach(chat => {
        sendUserState(chat.users, req.params['login'], online);
    });
    res.send({});
}

const handleFriendRequest = (req, res, state) => {
    db.users = db.users.map(user => {
        if (user.login === req.params['requestedLogin'] || user.login === req.params['login']) {
            const {friendRequests, login} = user;
            const {sended, received} = friendRequests;
            if (state === 'send') {
                return login === req.params['login'] ? {...user, friendRequests: {sended: [...sended, req.params['requestedLogin']], received}}
                : {...user, friendRequests: {sended, received: [...received, req.params['login']]}};
            }
            return login === req.params['login'] ? {...user, friendRequests: {sended: sended.filter(request => request !== req.params['requestedLogin']), received}}
            : {...user, friendRequests: {sended, received: received.filter(request => request !== req.params['login'])}};
        }
        return user;
    });
    writeDB();
    sendFriendRequestState(req.params['requestedLogin'], req.params['login'], state);
    res.send({});
}

const handleAnswerOnRequest = (req, res, answer) => {
    const id = crypto.randomBytes(8).toString('hex');
    db.users = db.users.map(user => {
        const {friendRequests, friends, friendNotifications, login} = user;
        const {sended, received} = friendRequests;
        if (login === req.params['requestedLogin']) {
            return {
                ...user, 
                friendRequests: {sended: sended.filter(request => request !== req.params['login']), received}, 
                friends: answer === 'accept' ? [...friends, req.params['login']] : friends,
                friendNotifications: [...friendNotifications, {id, login: req.params['login'], answer}]
            }
        } else if (login === req.params['login']) {
            return {
                ...user, 
                friendRequests: {sended, received: received.filter(request => request !== req.params['requestedLogin'])}, 
                friends: answer === 'accept' ? [...friends, req.params['requestedLogin']] : friends
            }
        }
        return user;
    });
    writeDB();
    sendFriendRequestState(req.params['requestedLogin'], req.params['login'], answer, id);
    if (answer !== 'decline') sendFriends(req.params['requestedLogin'], req.params['login'], answer);
    res.send({});
}

const handleBlockAction = (req, res, action) => {
    action === 'block' ?
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, blockedUsers: [...user.blockedUsers, req.params['requestedLogin']]} : user)
    : db.users = db.users.map(user => user.login === req.params['login'] ? {...user, blockedUsers: user.blockedUsers.filter(login => login !== req.params['requestedLogin'])} : user);
    sendLogin([req.params['requestedLogin'], req.params['login']], {login: req.params['requestedLogin'], block: action === 'block'});
    writeDB();
    res.send({});
}

const sendMessage = (chatUsers, message) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login));
    users.forEach(user => user.res.write(`data: ${JSON.stringify(message)}\n\n`));
}

const sendUserState = (chatUsers, login, online) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login) && user.login !== login);
    users.forEach(user => user.res.write(`data: ${JSON.stringify({online})}\n\n`));
}

const sendMessageId = (id, chatUsers) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login));
    users.forEach(user => user.res.write(`data: ${JSON.stringify({id})}\n\n`));
}

const sendTyping = (chatUsers, login) => {
    const [{typing}] = db.users.filter(user => user.login === login);
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login) && user.login !== login);
    users.forEach(user => user.res.write(`data: ${JSON.stringify({typing})}\n\n`));
}

const sendInfoOfDeletedMessage = (chatUsers, id, read, chatId) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login));
    users.forEach(user => user.res.write(`data: ${JSON.stringify({id, read, chatId, delete: true})}\n\n`));
}

const sendLogin = (chatUsers, obj) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login));
    users.forEach(user => user.res.write(`data: ${JSON.stringify(obj)}\n\n`));
}

const sendFriendRequestState = (requestedLogin, login, state, id) => {
    const [user] = db.users.filter(user => user.res && user.login === requestedLogin);
    const [{name, surname}] = db.users.filter(user => user.login === login);
    user ? user.res.write(`data: ${JSON.stringify({id, login, name, surname, state})}\n\n`) : null;
}

const sendFriends = (firstLogin, secondLogin, answer, id) => {
    const users = db.users.filter(user => user.res && (user.login === firstLogin || user.login === secondLogin));
    const [{name, surname}] = db.users.filter(user => user.login === secondLogin);
    users.forEach(user => user.res.write(`data: ${JSON.stringify({id, firstLogin, secondLogin, answer, name, surname})}\n\n`));
}

const sendDeletedChatId = (chatUsers, chatId) => {
    const users = db.users.filter(user => user.res && chatUsers.includes(user.login));
    users.forEach(user => user.res.write(`data: ${JSON.stringify({chatId})}\n\n`));
}

app.post('/check', (req, res) => {
    const [userWithThisLogin] = db.users.filter(user => user.login === req.body.login);
    if (!userWithThisLogin) return res.send({incorrectData: 'login'});
    scryptVerify(req.body.password, userWithThisLogin.password).then(isValid => isValid ? res.send(req.body) : res.send({incorrectData: 'password'}));
});

app.get('/isAvailable/:login', (req, res) => {
    const [userWithThisLogin] = db.users.filter(user => user.login === req.params['login']);
    userWithThisLogin ? res.send({available: false}) : res.send({available: true});
});

app.post('/users', upload.single('photo'), async (req, res) => {
    const hashedPassword = await scryptHash(req.body.password).then(hash => hash);
    req.body.password = hashedPassword;
    db.users.push({...req.body, counters: [], blockedUsers: [], friendRequests: {sended: [], received: []}, friends: [], friendNotifications: []});
    writeDB();
    res.send({login: req.body.login});
});

app.post('/updateProfile/:login', upload.single('photo'), (req, res) => {
    const [{image}] = db.users.filter(user => user.login === req.params['login']);
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, ...req.body} : user);
    writeDB();
    if (req.body.image !== image) {
        fs.rm(__dirname + `/socialMedia/images/${image}`, () => {});
    }
    res.send({login: req.params['login']});
});

app.get('/users/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    if (user) {
        const {name, surname, age, location, info, image} = user;
        res.send({name, surname, age, location, info, image});
    } 
});

app.get('/makeOnline/:login', (req, res) => switchOnline(req, res, true));
app.get('/users/:login/exit', (req, res) => switchOnline(req, res, false));

app.get('/isOnline/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    user.online ? res.send({online: true}) : res.send({online: false});
});

app.get('/search/:value', (req, res) => {
    const users = db.users.map(user => user.res ? {...user, res: ''} : user);
    const searchedUsers = users.filter(user =>  {
        const {name, surname, age, location} = user;
        const string = `${name} ${surname}, ${age} ${setAgeString(age)}, ${location}`;
        if (string.toLowerCase().includes(req.params['value'])) return user; 
    });
    res.send(searchedUsers);
});

app.get('/isChat/:users', (req, res) => {
    const [user1, user2] = req.params['users'].split(',');
    const [chatWithTheseUsers] = db.chats.filter(chat => chat.users.includes(user1) && chat.users.includes(user2));
    chatWithTheseUsers ? res.send({isChat: true}) : res.send({isChat: false});
});

app.get('/events/:myLogin', (req, res) => {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };

    res.writeHead(200, headers);

    db.users = db.users.map(user => user.login === req.params['myLogin'] ? {...user, res} : user); 
    res.write(`data: ${JSON.stringify('start')}\n\n`);
});

app.get('/chats/:chatId', (req, res) => {
    const [chat] = db.chats.filter(chat => chat.id === req.params['chatId']);
    const [{key}] = keys.keys.filter(item => item.id === req.params['chatId']);
    const messages = chat.messages.map(message => ({...message, text: decrypt(message.text, 'aes256', key)}));
    res.send({...chat, messages});
});

app.post('/chats', (req, res) => {
    const users = db.users.filter(user => user.res && req.body.users.includes(user.login));
    db.chats.push(req.body);
    createKey(req.body.id);
    db.users = db.users.map(user => req.body.users.includes(user.login) ? {...user, counters: [...user.counters, {id: req.body.id, number: 0}]} : user);
    writeDB();
    users.forEach(user => user.res.write(`data: ${JSON.stringify({chat: req.body})}\n\n`));
    res.send({id: req.body.id});
});

app.post('/chats/:chatId/messages', (req, res) => {
    const [chat] = db.chats.filter(chat => chat.id === req.params['chatId']);
    const [message] = chat.messages.filter(message => message.id === req.body.id);
    const [{key}] = keys.keys.filter(item => item.id === chat.id);
    if (message) {
        let index = 0;
        db.chats[db.chats.indexOf(chat)].messages[chat.messages.indexOf(message)] = {...req.body, text: encrypt(req.body.text, 'aes256', key), read: message.read};
        chat.messages.forEach((message, i) => message.id === req.body.id ? index = i : null);
        sendMessage(chat.users, {chatId: chat.id, ...req.body, read: message.read, index});
    } else {
        db.chats[db.chats.indexOf(chat)].messages.push({...req.body, text: encrypt(req.body.text, 'aes256', key), read: false});
        sendMessage(chat.users, {chatId: chat.id, ...req.body, read: false});
    }
    writeDB();
    res.send({});
});

app.get('/increaseCounter/:chatId/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    user.counters = user.counters.map(counter => counter.id === req.params['chatId'] ? {...counter, number: counter.number + 1} : counter);
    db.users[db.users.indexOf(user)] = user;
    writeDB();
    res.send({});
});

app.get('/resetCounter/:chatId/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    user.counters = user.counters.map(counter => counter.id === req.params['chatId'] ? {...counter, number: 0} : counter);
    db.users[db.users.indexOf(user)] = user;
    writeDB();
    res.send(user.counters);
});

app.get('/counters/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    res.send(user.counters);
});

app.get('/read/:chatId/:messageId', (req, res) => {
    const [chat] = db.chats.filter(chat => chat.id === req.params['chatId']);
    const [message] = chat.messages.filter(message => message.id === req.params['messageId']);
    message.read = true;
    chat.messages[chat.messages.indexOf(message)] = message;
    db.chats[db.chats.indexOf(chat)] = chat;
    writeDB();
    sendMessageId(message.id, chat.users);
    res.send({});
});

app.get('/setCurrentChat/:login/:chatId', (req, res) => {
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, currentChat: req.params['chatId']} : user);
    res.send({});
});

app.get('/resetCurrentChat/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    const [chat] = db.chats.filter(chat => chat.id === user.currentChat);
    if (chat) {
        const messages = chat.messages.filter(message => message.login !== req.params['login'] && !message.read);
        if (messages.length) {
            db.users = db.users.map(user => user.login === req.params['login'] ? {...user, counters: user.counters.map(counter => counter.id === chat.id ? {...counter, number: counter.number + messages.length} : counter)} : user);
            writeDB();
        }
        const users = db.users.filter(user => user.currentChat === chat.id && user.login !== req.params['login']);
        if (!chat.messages.length && !users.length) {
            db.chats = db.chats.filter(item => item.id !== chat.id);
            db.users = db.users.map(user => chat.users.includes(user.login) ? {...user, counters: user.counters.filter(counter => counter.id !== chat.id)} : user);
            keys.keys = keys.keys.filter(item => item.id !== chat.id);
            writeDB();
            fs.writeFile(__dirname + '/socialMedia/keys.json', JSON.stringify(keys), () => {});
            sendDeletedChatId(chat.users, chat.id);
        }
        db.users = db.users.map(user => user.login === req.params['login'] ? {...user, currentChat: ''} : user);
    }
    res.send({});
});

app.get('/getCurrentChat/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    res.send({chatId: user.currentChat});
});

app.get('/setTyping/:login/:chatId', (req, res) => {
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, typing: true} : user);
    const [{users}] = db.chats.filter(chat => chat.id === req.params['chatId']);
    sendTyping(users, req.params['login']);
    res.send({});
});

app.get('/resetTyping/:login', (req, res) => {
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, typing: false} : user);
    const [{currentChat}] = db.users.filter(user => user.login === req.params['login']);
    const [{users}] = db.chats.filter(chat => chat.id === currentChat);
    sendTyping(users, req.params['login']);
    res.send({});
});

app.get('/isTyping/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    user.typing ? res.send({typing: true}) : res.send({typing: false});
});

app.get('/deleteMessage/:chatId/:messageId', (req, res) => {
    const [chat] = db.chats.filter(chat => chat.id === req.params['chatId']);
    const [message] = chat.messages.filter(message => message.id === req.params['messageId']);
    let users = db.users.filter(user => chat.users.includes(user.login) && user.login !== message.login && user.currentChat !== chat.id);
    chat.messages = chat.messages.filter(item => item.id !== message.id);
    db.chats[db.chats.indexOf(chat)] = chat;
    users = users.map(user => message.read ? user : {...user, counters: user.counters.map(counter => counter.id === chat.id ? {...counter, number: counter.number - 1} : counter)});
    users.forEach(user => {
        db.users = db.users.map(item => item.login === user.login ? user : item);
    });
    sendInfoOfDeletedMessage(chat.users, req.params['messageId'], message.read, chat.id);
    writeDB();
    res.send({});
});

app.get('/blockedUsers/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['login']);
    res.send(user.blockedUsers);
});

app.get('/isBlocked/:requestedLogin/:login', (req, res) => {
    const [user] = db.users.filter(user => user.login === req.params['requestedLogin']);
    user.blockedUsers.includes(req.params['login']) ? res.send({isBlocked: true}) : res.send({isBlocked: false});
});

app.get('/unlock/:requestedLogin/:login', (req, res) => handleBlockAction(req, res, 'unlock'));
app.get('/block/:requestedLogin/:login', (req, res) => handleBlockAction(req, res, 'block'));

app.get('/lastMessages/:login', (req, res) => {
    const [{counters}] = db.users.filter(user => user.login === req.params['login']);
    if (counters.length) {
        const chatIds = counters.map(counter => counter.id);
        let chats = [];
        chatIds.forEach(chatId => {
            const [{users, messages}] = db.chats.filter(chat => chat.id === chatId);
            const [{key}] = keys.keys.filter(key => key.id === chatId);
            if (users.length === 2) {
                const [{name, surname, image}] = db.users.filter(user => users.includes(user.login) && user.login !== req.params['login']);
                chats.push({chatId, name, surname, image, lastMessage: messages.length ? {...messages[messages.length - 1], text: decrypt(messages[messages.length - 1].text, 'aes256', key)} : {}});
            }
        });
        res.send(chats); 
    } else res.send([]);
});

app.get('/getLastMessage/:chatId', (req, res) => {
    const [{messages}] = db.chats.filter(chat => chat.id === req.params['chatId']);
    if (messages.length) {
        const [{key}] = keys.keys.filter(key => key.id === req.params['chatId']);
        res.send({chatId: req.params['chatId'], ...messages[messages.length - 1], text: decrypt(messages[messages.length - 1].text, 'aes256', key)});
    } else res.send({chatId: req.params['chatId'], text: ''});
});

app.get('/friendRequests/:login', (req, res) => {
    const [{friendRequests}] = db.users.filter(user => user.login === req.params['login']);
    res.send(friendRequests); 
});

app.get('/friends/:login', (req, res) => {
    const [{friends}] = db.users.filter(user => user.login === req.params['login']);
    res.send(friends); 
});

app.get('/friendRequest/:requestedLogin/:login', (req, res) => handleFriendRequest(req, res, 'send'));
app.get('/cancelFriendRequest/:requestedLogin/:login', (req, res) => handleFriendRequest(req, res, 'cancel'));

app.get('/acceptFriendRequest/:requestedLogin/:login', (req, res) => handleAnswerOnRequest(req, res, 'accept'));
app.get('/declineFriendRequest/:requestedLogin/:login', (req, res) => handleAnswerOnRequest(req, res, 'decline'));

app.get('/friendNotifications/:login', (req, res) => {
    let [{friendNotifications}] = db.users.filter(user => user.login === req.params['login']);
    friendNotifications = friendNotifications.map(not => {
        const [{name, surname}] = db.users.filter(user => user.login === not.login);
        return {...not, name, surname};
    });
    res.send(friendNotifications);
});

app.get('/readFriendNotification/:login/:id', (req, res) => {
    db.users = db.users.map(user => user.login === req.params['login'] ? {...user, friendNotifications: user.friendNotifications.filter(item => item.id !== req.params['id'])} : user);
    writeDB();
    res.send({});
});

app.get('/deleteFriend/:requestedLogin/:login', (req, res) => {
    const id = crypto.randomBytes(8).toString('hex');
    db.users = db.users.map(user => {
        const {friends, friendNotifications} = user;
        if (user.login === req.params['requestedLogin']) {
            return {
                ...user, 
                friends: friends.filter(friend => friend !== req.params['login']), 
                friendNotifications: [...friendNotifications, {id, login: req.params['login'], answer: 'delete'}]
            }
        } else if (user.login === req.params['login']) {
            return {...user, friends: friends.filter(friend => friend !== req.params['requestedLogin'])}
        }
        return user;
    });
    writeDB();
    sendFriends(req.params['requestedLogin'], req.params['login'], 'delete', id);
    res.send({});
});

const port = 3000;

app.listen(port);

module.exports = app;