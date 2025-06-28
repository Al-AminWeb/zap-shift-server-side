const express = require('express');
const {MongoClient, ServerApiVersion} = require('mongodb');
const cors = require('cors');
const dotenv = require('dotenv');
const app = express();
dotenv.config();
const port = process.env.PORT || 3000;


app.use(cors());
app.use(express.json());


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9c3lw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        const db = client.db('parcelDB');
        const parcelCollection = db.collection('parcels');

        app.get('/parcels', async  (req, res) => {
            const parcels = await parcelCollection.find().toArray();
            res.send(parcels);
        })

        await client.db("admin").command({ping: 1});
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
    }
}

run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('zap shift server-side');
})

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
})