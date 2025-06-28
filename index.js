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

        app.get('/parcels', async (req, res) => {
            const parcels = await parcelCollection.find().toArray();
            res.send(parcels);
        })

        /* ----------  POST a new parcel  ---------- */
        app.post('/parcels', async (req, res) => {
            try {
                /* ── 1. Basic validation ── */
                const required = [
                    'type',
                    'title',
                    'senderName',
                    'senderContact',
                    'senderEmail',
                    'senderRegion',
                    'senderCenter',
                    'senderAddress',
                    'pickupInstruction',
                    'receiverName',
                    'receiverContact',
                    'receiverRegion',
                    'receiverCenter',
                    'receiverAddress',
                    'deliveryInstruction',
                    'createdBy'
                ];
                const missing = required.filter(k => !req.body?.[k]);
                if (missing.length) {
                    return res
                        .status(400)
                        .json({error: `Missing required fields: ${missing.join(', ')}`});
                }

                /* ── 2. Attach server‑trusted timestamps ── */
                const now = Date.now();                      //Unix (ms)
                const parcelDoc = {
                    ...req.body,
                    createdAtUnix: now,
                    createdAtISO: new Date(now).toISOString()
                };

                /* ── 3. Save to MongoDB ── */
                const result = await parcelCollection.insertOne(parcelDoc);

                /* ── 4. Respond ── */
                res.status(201).json({
                    message: 'Parcel saved successfully.',
                    insertedId: result.insertedId
                });
            } catch (err) {
                console.error('❌  Failed to save parcel:', err);
                res
                    .status(500)
                    .json({error: 'Something went wrong while saving the parcel.'});
            }
        });

        /* ----------  GET /parcels — all or by user, sorted by ISO date ---------- */
        app.get('/parcels', async (req, res) => {
            try {
                const filter = {};

                // Optional: filter by user e‑mail via createdBy field
                if (req.query.createdBy) {
                    filter.createdBy = req.query.createdBy;
                }

                // Fetch parcels sorted by createdAtISO (latest first)
                const parcels = await parcelCollection
                    .find(filter)
                    .sort({ createdAtISO: -1 })  // ISO strings sort chronologically
                    .toArray();

                res.json(parcels);
            } catch (err) {
                console.error('❌ Error fetching parcels:', err);
                res.status(500).json({ error: 'Failed to fetch parcel data.' });
            }
        });


        const { ObjectId } = require('mongodb'); // 👈 Required at the top

        app.delete('/parcels/:id', async (req, res) => {
            try {
                const id = req.params.id;

                // Validate ObjectId
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ error: 'Invalid parcel ID.' });
                }

                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).json({ error: 'Parcel not found.' });
                }

                res.json({ message: 'Parcel deleted successfully.' });
            } catch (err) {
                console.error('❌ Error deleting parcel:', err);
                res.status(500).json({ error: 'Failed to delete parcel.' });
            }
        });


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